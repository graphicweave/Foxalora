import { Kysely, sql } from 'kysely';

/**
 * Admin console (FOX-081 separate administrator authentication, FOX-134 two-step verification).
 *
 * - totp_secret (existing column) holds the envelope-encrypted TOTP secret, pending until the
 *   first code is confirmed; totp_enabled_at marks it as active.
 * - backup_codes: SHA-256 hashes of the one-time backup codes (high-entropy random codes, so a
 *   fast hash is enough); a used code is removed from the list.
 * - admin_login_lookup(): the only cross-tenant read of admin_users. It returns the account of an
 *   active tenant for one email address, so the runtime role can check a password before it knows
 *   the tenant; everything after login runs under row-level security as usual.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE admin_users
      ADD COLUMN totp_enabled_at timestamptz,
      ADD COLUMN backup_codes jsonb NOT NULL DEFAULT '[]';

    CREATE FUNCTION admin_login_lookup(p_email text)
    RETURNS TABLE (id uuid, tenant_id uuid, password_hash text)
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
      SELECT a.id, a.tenant_id, a.password_hash
        FROM admin_users a JOIN tenants t ON t.id = a.tenant_id
       WHERE a.email = lower(p_email) AND t.status = 'active'
    $$;
    REVOKE ALL ON FUNCTION admin_login_lookup(text) FROM PUBLIC;
  `.execute(db);

  await sql`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'foxalora_app') THEN
        GRANT EXECUTE ON FUNCTION admin_login_lookup(text) TO foxalora_app;
      END IF;
    END $$;
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DROP FUNCTION IF EXISTS admin_login_lookup(text);
    ALTER TABLE admin_users DROP COLUMN IF EXISTS backup_codes, DROP COLUMN IF EXISTS totp_enabled_at;
  `.execute(db);
}
