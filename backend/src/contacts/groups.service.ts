import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { sql } from 'kysely';
import { CONTROL_CHARS } from '../common/email';
import { TenantDb, type TenantContext } from '../database/tenant-db';
import type { Owner } from './contacts.service';

export interface GroupView { id: string; name: string; members: number }

export const MAX_GROUPS = 200;
const NAME_MAX = 100;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PG_UNIQUE_VIOLATION = '23505';
const PG_FK_VIOLATION = '23503';

const ctx = (o: Owner): TenantContext => ({ tenantId: o.tenantId, mailbox: o.email });

function parseName(body: unknown): string {
  const b = (body ?? {}) as { name?: unknown };
  if (typeof b.name !== 'string' || CONTROL_CHARS.test(b.name)) throw new BadRequestException('Group not saved: the name is not valid.');
  const name = b.name.trim();
  if (!name || name.length > NAME_MAX) throw new BadRequestException(`Group not saved: the name must be 1 to ${NAME_MAX} characters.`);
  return name;
}

const isUnique = (e: unknown) => (e as { code?: string })?.code === PG_UNIQUE_VIOLATION;

/**
 * Contact groups (D-014). Rows live behind the same mailbox RLS policy as contacts;
 * membership FKs are composite over (id, tenant_id, mailbox), so even a bug here
 * could not link another mailbox's contact or group.
 */
@Injectable()
export class GroupsService {
  constructor(private readonly tdb: TenantDb) {}

  async list(o: Owner): Promise<{ items: GroupView[] }> {
    const rows = await this.tdb.run(ctx(o), (trx) =>
      trx
        .selectFrom('contact_groups as g')
        .leftJoin('contact_group_members as m', 'm.group_id', 'g.id')
        .select(['g.id', 'g.name', (eb) => eb.fn.count<string>('m.id').as('members')])
        .groupBy(['g.id', 'g.name'])
        .orderBy(sql`lower(g.name)`)
        .execute(),
    );
    return { items: rows.map((r) => ({ id: r.id, name: r.name, members: Number(r.members) })) };
  }

  async create(o: Owner, body: unknown): Promise<GroupView> {
    const name = parseName(body);
    try {
      return await this.tdb.run(ctx(o), async (trx) => {
        const { n } = await trx.selectFrom('contact_groups').select((eb) => eb.fn.countAll<string>().as('n')).executeTakeFirstOrThrow();
        if (Number(n) >= MAX_GROUPS) throw new BadRequestException(`an address book holds at most ${MAX_GROUPS} groups`);
        const row = await trx
          .insertInto('contact_groups')
          .values({ tenant_id: o.tenantId, mailbox: o.email.toLowerCase(), name })
          .returning('id')
          .executeTakeFirstOrThrow();
        return { id: row.id, name, members: 0 };
      });
    } catch (e) {
      if (isUnique(e)) throw new BadRequestException('Group not saved: a group with this name already exists.');
      throw e;
    }
  }

  async rename(o: Owner, id: string, body: unknown): Promise<{ id: string; name: string }> {
    if (!UUID.test(id)) throw new NotFoundException();
    const name = parseName(body);
    try {
      const row = await this.tdb.run(ctx(o), (trx) =>
        trx.updateTable('contact_groups').set({ name, updated_at: new Date() }).where('id', '=', id).returning('id').executeTakeFirst(),
      );
      if (!row) throw new NotFoundException();
      return { id, name };
    } catch (e) {
      if (isUnique(e)) throw new BadRequestException('Group not saved: a group with this name already exists.');
      throw e;
    }
  }

  async remove(o: Owner, id: string): Promise<void> {
    if (!UUID.test(id)) throw new NotFoundException();
    const row = await this.tdb.run(ctx(o), (trx) => trx.deleteFrom('contact_groups').where('id', '=', id).returning('id').executeTakeFirst());
    if (!row) throw new NotFoundException();
  }

  /** Adds a contact to a group. 404 for ids that are not the signed-in mailbox's. */
  async addMember(o: Owner, groupId: string, body: unknown): Promise<void> {
    const contactId = String((body as { contactId?: unknown })?.contactId ?? '');
    if (!UUID.test(groupId) || !UUID.test(contactId)) throw new NotFoundException();
    try {
      await this.tdb.run(ctx(o), async (trx) => {
        // Both lookups run under RLS: foreign ids are simply not found.
        const group = await trx.selectFrom('contact_groups').select('id').where('id', '=', groupId).executeTakeFirst();
        const contact = await trx.selectFrom('contacts').select('id').where('id', '=', contactId).executeTakeFirst();
        if (!group || !contact) throw new NotFoundException();
        await trx
          .insertInto('contact_group_members')
          .values({ tenant_id: o.tenantId, mailbox: o.email.toLowerCase(), group_id: groupId, contact_id: contactId })
          .onConflict((oc) => oc.columns(['group_id', 'contact_id']).doNothing())
          .execute();
      });
    } catch (e) {
      // The group or contact was deleted between the checks and the insert.
      if ((e as { code?: string })?.code === PG_FK_VIOLATION) throw new NotFoundException();
      throw e;
    }
  }

  async removeMember(o: Owner, groupId: string, contactId: string): Promise<void> {
    if (!UUID.test(groupId) || !UUID.test(contactId)) throw new NotFoundException();
    await this.tdb.run(ctx(o), async (trx) => {
      const gone = await trx.deleteFrom('contact_group_members').where('group_id', '=', groupId).where('contact_id', '=', contactId).returning('id').executeTakeFirst();
      if (gone) return;
      const group = await trx.selectFrom('contact_groups').select('id').where('id', '=', groupId).executeTakeFirst();
      if (!group) throw new NotFoundException();
    });
  }

  /** One address per member (the contact's first), for "Write to group". */
  async addresses(o: Owner, id: string): Promise<{ emails: string[] }> {
    if (!UUID.test(id)) throw new NotFoundException();
    return this.tdb.run(ctx(o), async (trx) => {
      const group = await trx.selectFrom('contact_groups').select('id').where('id', '=', id).executeTakeFirst();
      if (!group) throw new NotFoundException();
      const rows = await trx
        .selectFrom('contact_group_members as m')
        .innerJoin('contact_addresses as a', 'a.contact_id', 'm.contact_id')
        .select(['m.contact_id', 'a.email', 'a.position'])
        .where('m.group_id', '=', id)
        .orderBy('a.position')
        .execute();
      const first = new Map<string, string>();
      for (const r of rows) if (!first.has(r.contact_id)) first.set(r.contact_id, r.email);
      const seen = new Set<string>();
      const emails: string[] = [];
      for (const e of first.values()) {
        if (seen.has(e.toLowerCase())) continue;
        seen.add(e.toLowerCase());
        emails.push(e);
      }
      return { emails };
    });
  }
}
