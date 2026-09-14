const { Pool } = require('pg');
const env = require('./env');

const pool = new Pool({
  connectionString: env.databaseUrl,
  ssl: env.databaseSsl ? { rejectUnauthorized: false } : undefined,
  max: 10,
});

async function connectDB() {
  await pool.query(`
    CREATE EXTENSION IF NOT EXISTS pgcrypto;
    CREATE TABLE IF NOT EXISTS users (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), display_name text NOT NULL,
      username text UNIQUE NOT NULL, email text UNIQUE NOT NULL, password text NOT NULL,
      role text NOT NULL DEFAULT 'user', bio text NOT NULL DEFAULT '', library jsonb NOT NULL DEFAULT '[]',
      downloads jsonb NOT NULL DEFAULT '[]', agreed_to_terms_at timestamptz NOT NULL,
      age_confirmed boolean NOT NULL DEFAULT true, is_banned boolean NOT NULL DEFAULT false,
      ban_reason text, last_login_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS series (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), title text NOT NULL, slug text UNIQUE NOT NULL,
      type text NOT NULL, owner uuid NOT NULL REFERENCES users(id), author text NOT NULL, artist text,
      genres jsonb NOT NULL DEFAULT '[]', tags jsonb NOT NULL DEFAULT '[]', status text NOT NULL DEFAULT 'Ongoing',
      synopsis text NOT NULL, cover_image text, views jsonb NOT NULL DEFAULT '{"daily":0,"weekly":0,"alltime":0}',
      last_daily_reset timestamptz NOT NULL DEFAULT now(), last_weekly_reset timestamptz NOT NULL DEFAULT now(),
      rating_avg numeric NOT NULL DEFAULT 0, rating_count integer NOT NULL DEFAULT 0, chapter_count integer NOT NULL DEFAULT 0,
      rights_attested_at timestamptz NOT NULL, is_removed boolean NOT NULL DEFAULT false, takedown_reason text,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS chapters (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), series uuid NOT NULL REFERENCES series(id), num integer NOT NULL,
      title text NOT NULL, paragraphs jsonb, pages jsonb, views integer NOT NULL DEFAULT 0, is_removed boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(series,num)
    );
    CREATE TABLE IF NOT EXISTS comments (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), series uuid NOT NULL REFERENCES series(id), "user" uuid NOT NULL REFERENCES users(id),
      rating integer NOT NULL, text text NOT NULL, parent uuid REFERENCES comments(id), is_removed boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS notifications (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "user" uuid NOT NULL REFERENCES users(id), type text NOT NULL,
      message text NOT NULL, series uuid REFERENCES series(id), is_read boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS reading_progress (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "user" uuid NOT NULL REFERENCES users(id), series uuid NOT NULL REFERENCES series(id),
      chapter uuid NOT NULL REFERENCES chapters(id), type text NOT NULL, scroll_pct numeric NOT NULL DEFAULT 0,
      page integer NOT NULL DEFAULT 0, bookmarked boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE("user",series)
    );
    CREATE TABLE IF NOT EXISTS dmca_reports (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), reporter_name text NOT NULL, reporter_email text NOT NULL,
      reporter_organization text, reporter_address text, copyrighted_work_description text NOT NULL, original_work_url text,
      infringing_series uuid REFERENCES series(id), infringing_chapter uuid REFERENCES chapters(id), infringing_url_description text,
      good_faith_statement boolean NOT NULL, accuracy_statement boolean NOT NULL, signature text NOT NULL,
      status text NOT NULL DEFAULT 'pending', admin_notes text, resolved_at timestamptz, resolved_by uuid REFERENCES users(id),
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  console.log('[db] Connected to PostgreSQL');
}

module.exports = { pool, connectDB };
