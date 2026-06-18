-- Set passwords for the Supabase service roles this stack actually connects
-- as. The supabase/postgres image CREATEs these roles but leaves their login
-- passwords unset, so gotrue (supabase_auth_admin) and PostgREST
-- (authenticator) cannot connect until we set them. Mirrors the
-- ALTER USER ... WITH PASSWORD step of supabase/docker's roles.sql.
--
-- Run by the migrate service as the `supabase_admin` superuser (authenticator
-- is a reserved role only a superuser may ALTER, and the image demotes the
-- `postgres` role). :'pg_password' is bound from PGPASSWORD via psql -v.

ALTER USER authenticator WITH PASSWORD :'pg_password';
ALTER USER supabase_auth_admin WITH PASSWORD :'pg_password';
