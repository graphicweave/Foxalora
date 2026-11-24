import { Kysely, sql } from 'kysely';

/**
 * Contact groups (D-014). Group and membership rows carry tenant_id + mailbox and
 * sit behind the same mailbox_isolation RLS policy as contacts. Membership FKs are
 * composite over (id, tenant_id, mailbox), so a row cannot reference a group or a
 * contact of another mailbox even if application code slips.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE contact_groups (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      mailbox text NOT NULL CHECK (mailbox = lower(mailbox) AND length(mailbox) <= 320),
      name text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (id, tenant_id, mailbox)
    );
    CREATE UNIQUE INDEX contact_groups_name_idx ON contact_groups (tenant_id, mailbox, lower(name));

    ALTER TABLE contacts ADD CONSTRAINT contacts_id_tenant_mailbox_key UNIQUE (id, tenant_id, mailbox);

    CREATE TABLE contact_group_members (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      mailbox text NOT NULL CHECK (mailbox = lower(mailbox) AND length(mailbox) <= 320),
      group_id uuid NOT NULL,
      contact_id uuid NOT NULL,
      UNIQUE (group_id, contact_id),
      FOREIGN KEY (group_id, tenant_id, mailbox) REFERENCES contact_groups (id, tenant_id, mailbox) ON DELETE CASCADE,
      FOREIGN KEY (contact_id, tenant_id, mailbox) REFERENCES contacts (id, tenant_id, mailbox) ON DELETE CASCADE
    );
    CREATE INDEX contact_group_members_contact_idx ON contact_group_members (contact_id);

    ALTER TABLE contact_groups ENABLE ROW LEVEL SECURITY;
    CREATE POLICY mailbox_isolation ON contact_groups
      USING (tenant_id = app_tenant_id() AND mailbox = app_mailbox())
      WITH CHECK (tenant_id = app_tenant_id() AND mailbox = app_mailbox());
    ALTER TABLE contact_group_members ENABLE ROW LEVEL SECURITY;
    CREATE POLICY mailbox_isolation ON contact_group_members
      USING (tenant_id = app_tenant_id() AND mailbox = app_mailbox())
      WITH CHECK (tenant_id = app_tenant_id() AND mailbox = app_mailbox());
  `.execute(db);
  await sql`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'foxalora_app') THEN
        GRANT SELECT, INSERT, UPDATE, DELETE ON contact_groups TO foxalora_app;
        GRANT SELECT, INSERT, DELETE ON contact_group_members TO foxalora_app;
      END IF;
    END $$;
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DROP TABLE IF EXISTS contact_group_members;
    DROP TABLE IF EXISTS contact_groups;
    ALTER TABLE contacts DROP CONSTRAINT IF EXISTS contacts_id_tenant_mailbox_key;
  `.execute(db);
}
