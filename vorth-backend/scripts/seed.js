#!/usr/bin/env node
/**
 * Populates a fresh database with demo content so a first deploy is not an
 * empty shell.
 *
 *   npm run db:seed                 # refuses without --confirm
 *   npm run db:seed -- --confirm    # creates users, series, chapters, reviews
 *   npm run db:seed -- --confirm --fresh   # wipe the catalog first
 *
 * Every account uses a fixed, well-known demo password and is marked
 * unverified-free (no mail required). These are NOT production credentials:
 * the script refuses to run when NODE_ENV=production unless FORCE=1.
 */
const env = require('../src/config/env');
const { pool, connectDB, withTransaction } = require('../src/config/db');
const User = require('../src/models/User');
const Series = require('../src/models/Series');
const Chapter = require('../src/models/Chapter');
const Comment = require('../src/models/Comment');
const Notification = require('../src/models/Notification');

const DEMO_PASSWORD = 'vorthdemo123';

const AUTHORS = [
  {
    username: 'wren_halloway', displayName: 'Wren Halloway',
    email: 'wren@vorth.example', bio: 'Writes about cities that remember.',
    series: [
      {
        title: 'The Clockwork Lantern', type: 'novel', status: 'Ongoing',
        author: 'Wren Halloway', genres: ['Fantasy', 'Mystery'], tags: ['slow-burn', 'found-family'],
        synopsis: 'A lamplighter discovers the city keeps time with something older than the clocktower, and that every wick she trims is a promise somebody broke.',
        chapters: [
          { title: 'The Eleventh Wick', paragraphs: [
            'She trimmed the wick with her thumbnail, one careful twist. The lantern did not go out. That was the trouble.',
            'In her grandmother\'s district the wicks had been trimmed short for a living, and the streets had kept their own hours. Here the light leaned, patient, waiting for a hand that would never come.',
            'Nin climbed. Eleven flights, counting the landings the way she had been taught, and at the top the brass was warm under her palm.',
          ] },
          { title: 'What the Tower Owes', paragraphs: [
            'The keeper had a face like a ledger balanced to the penny.',
            '"You trimmed the eleventh," he said. "Do you know what that means?"',
            '"It means I did my job."',
            '"It means you are owed an answer," said the keeper, "and the tower does not pay its debts in coin."',
          ] },
          { title: 'A Ledger of Small Repayments', paragraphs: [
            'By the third week she had learned the tower\'s arithmetic: one lantern for one promise, and interest paid in weather.',
            'It had begun raining indoors. Not a leak. An accounting.',
          ] },
        ],
        reviews: [
          { rating: 5, text: 'The opening paragraph is doing a lot of work and all of it lands. Beautifully observed.' },
          { rating: 4, text: 'Slow to start but the payoff in chapter three is worth the patience.' },
          { rating: 5, text: 'Read it twice. The clock metaphor is quietly devastating.' },
        ],
      },
      {
        title: 'Salt and Starlight', type: 'novel', status: 'Ongoing',
        author: 'Wren Halloway', genres: ['Romance', 'Drama'], tags: ['coastal', 'second-chance'],
        synopsis: 'Two lighthouses, one storm, and a decade of silence between the keepers who tend them.',
        chapters: [
          { title: 'The Keeper Who Came Back', paragraphs: [
            'The lamp turned at four, as it had every night for eleven years, and this time somebody was standing in the gallery to see it.',
            '"You kept it lit," said Maren.',
            '"Someone had to."',
          ] },
        ],
        reviews: [{ rating: 4, text: 'Tension carried the whole way through. Would love a second volume.' }],
      },
    ],
  },
  {
    username: 'orin_vale', displayName: 'Orin Vale',
    email: 'orin@vorth.example', bio: 'Panelist. Ink first, words second.',
    series: [
      {
        title: 'Nine Lanterns for the Drowned Quarter', type: 'comic', status: 'Ongoing',
        author: 'Orin Vale', artist: 'Orin Vale', genres: ['Horror', 'Fantasy'], tags: ['mystery', 'coastal'],
        synopsis: 'Nine panels, one per lantern, and a quarter of the city that only appears when all of them are lit at once.',
        chapters: [
          { title: 'Chapter 1 — The First Lantern', pages: ['/uploads/seed-page-1.png', '/uploads/seed-page-2.png'] },
          { title: 'Chapter 2 — Salt in the Ink', pages: ['/uploads/seed-page-3.png'] },
        ],
        reviews: [{ rating: 5, text: 'The panel layouts on page two are genuinely gorgeous.' }],
      },
      {
        title: 'Static Garden', type: 'comic', status: 'Completed',
        author: 'Orin Vale', artist: 'J. Adeyemi', genres: ['Sci-Fi', 'Drama'], tags: ['dystopia'],
        synopsis: 'In a city where plants are rationed, a botanist grows something the council never meant to see.',
        chapters: [{ title: 'Chapter 1 — Ration Day', pages: ['/uploads/seed-page-1.png'] }],
        reviews: [{ rating: 4, text: 'Finished it in one sitting. The last spread is a gut punch.' }],
      },
    ],
  },
  {
    username: 'sable_kent', displayName: 'Sable Kent',
    email: 'sable@vorth.example', bio: 'Editor. Occasionally writes.',
    series: [
      {
        title: 'Small Hours at the Harbour Office', type: 'novel', status: 'Completed',
        author: 'Sable Kent', genres: ['Slice of Life', 'Mystery'], tags: ['coastal', 'workplace'],
        synopsis: 'Nine short stories about the people who keep a harbour town running between midnight and six.',
        chapters: [
          { title: 'Night Shift', paragraphs: [
            'The harbour office kept no clock. It had a tide instead, and tides were more punctual than any manager she had ever worked for.',
          ] },
          { title: 'The Ledger of Small Favours', paragraphs: [
            'Everything at the harbour office was owed to somebody. The trick was keeping the list straight.',
          ] },
        ],
        reviews: [
          { rating: 5, text: 'Quiet and precise. Exactly what I wanted this week.' },
          { rating: 5, text: 'The tide-as-clock metaphor is quietly brilliant.' },
        ],
      },
    ],
  },
];

const otherReaders = [
  { username: 'maren_reads', displayName: 'Maren Oyelaran' },
  { username: 'tobin', displayName: 'Tobin Ash' },
  { username: 'ilse', displayName: 'Ilse Moreau' },
];

async function wipeCatalog() {
  await withTransaction(async (client) => {
    await client.query('DELETE FROM notifications');
    await client.query('DELETE FROM reading_progress');
    await client.query('DELETE FROM comments');
    await client.query('DELETE FROM view_events');
    await client.query('DELETE FROM chapters');
    await client.query('DELETE FROM dmca_reports');
    await client.query('DELETE FROM series');
    await client.query('DELETE FROM refresh_tokens');
    await client.query('DELETE FROM auth_tokens');
    await client.query('DELETE FROM users');
  });
}

/** Recomputes a series' cached rating, mirroring the runtime rollup. */
async function syncRating(seriesId) {
  await pool.query(
    `UPDATE "series" AS s
        SET "rating_avg"   = COALESCE(r.avg, 0),
            "rating_count" = COALESCE(r.count, 0),
            "updated_at"   = now()
       FROM (SELECT ROUND(AVG("rating")::numeric, 1)::float8 AS avg, COUNT(*)::int AS count
               FROM "comments" WHERE "series" = $1 AND "is_removed" = false) AS r
      WHERE s."id" = $1`,
    [seriesId]
  );
}

async function run() {
  const args = process.argv.slice(2);
  if (!args.includes('--confirm')) {
    console.log('Refusing to seed without --confirm.');
    console.log('Usage: node scripts/seed.js --confirm [--fresh]');
    process.exit(1);
  }
  if (env.nodeEnv === 'production' && process.env.FORCE !== '1') {
    console.error('Refusing to seed a production database without FORCE=1.');
    process.exit(1);
  }

  await connectDB();
  if (args.includes('--fresh')) {
    await wipeCatalog();
    console.log('Cleared existing catalog data.');
  }

  const created = [];
  for (const author of AUTHORS) {
    // Idempotent: skip an author that already exists.
    const existing = await User.findOne({ username: author.username }).exec();
    if (existing) {
      console.log(`  = ${author.username} (already present, skipping)`);
      created.push(existing);
      continue;
    }
     
    const user = await User.create({
      displayName: author.displayName,
      username: author.username,
      email: author.email,
      password: DEMO_PASSWORD,
      bio: author.bio,
      agreedToTermsAt: new Date(),
      ageConfirmed: true,
      emailVerifiedAt: new Date(),
      lastLoginAt: new Date(),
    });
    created.push(user);
    console.log(`  + user ${author.username}`);
  }

  // Reviewers, so the seeded reviews are not all self-authored.
  const reviewers = [];
  for (const reader of otherReaders) {
     
    const found = await User.findOne({ username: reader.username }).exec();
    if (found) { reviewers.push(found); continue; }
     
    const u = await User.create({
      displayName: reader.displayName,
      username: reader.username,
      email: `${reader.username}@vorth.example`,
      password: DEMO_PASSWORD,
      agreedToTermsAt: new Date(),
      ageConfirmed: true,
      emailVerifiedAt: new Date(),
    });
    reviewers.push(u);
    console.log(`  + reader ${reader.username}`);
  }

  let seriesCount = 0;
  let chapterCount = 0;
  let reviewCount = 0;

  for (const author of AUTHORS) {
    const owner = created.find((u) => u.username === author.username);

    for (const spec of author.series) {
       
      const found = await Series.findOne({ slug: spec.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') }).exec();
      if (found) { console.log(`  = ${spec.title} (already present, skipping)`); continue; }

       
      const series = await Series.create({
        title: spec.title,
        type: spec.type,
        owner: owner.id,
        author: spec.author,
        artist: spec.artist || null,
        genres: spec.genres,
        tags: spec.tags,
        status: spec.status,
        synopsis: spec.synopsis,
        rightsAttestedAt: new Date(),
      });
      seriesCount += 1;
      console.log(`  + series ${series.title}`);

      let num = 0;
      for (const chapterSpec of spec.chapters) {
        num += 1;
         
        await Chapter.create({
          series: series.id,
          num,
          title: chapterSpec.title,
          paragraphs: spec.type === 'novel' ? chapterSpec.paragraphs : undefined,
          pages: spec.type === 'comic' ? chapterSpec.pages : undefined,
        });
        chapterCount += 1;
      }
      await pool.query('UPDATE "series" SET "chapter_count" = $1 WHERE "id" = $2', [num, series.id]);

      // Reviews, spread across the reviewers.
      let i = 0;
      for (const review of spec.reviews) {
        const reviewer = reviewers[i % reviewers.length];
        i += 1;
         
        await Comment.create({
          series: series.id,
          user: reviewer.id,
          rating: review.rating,
          text: review.text,
        });
        reviewCount += 1;
      }
       
      await syncRating(series.id);

      // Give every series a plausible view history so rankings are not empty.
      // The ::int casts matter: jsonb_build_object cannot infer the type of an
      // untyped bind parameter and errors with 42P18.
      await pool.query(
        `UPDATE "series" SET "views" = jsonb_build_object(
           'daily', $2::int, 'weekly', $3::int, 'alltime', $4::int)
          WHERE "id" = $1`,
        [series.id, 40 + seriesCount * 7, 180 + seriesCount * 30, 900 + seriesCount * 250]
      );
    }
  }

  // A couple of notifications so the bell is not empty on first sign-in.
  const firstOwner = created[0];
  const firstSeries = await Series.find({ owner: firstOwner.id }).sort({ createdAt: 1 }).limit(1).exec();
  if (firstSeries[0]) {
    await Notification.insertMany(reviewers.slice(0, 2).map((r) => ({
      user: r.id,
      type: 'new_chapter',
      message: `${firstSeries[0].title} just released a new chapter.`,
      series: firstSeries[0].id,
    })));
  }

  console.log(`
Seeded:
  ${seriesCount} series, ${chapterCount} chapters, ${reviewCount} reviews
  ${created.length} authors, ${reviewers.length} readers

Every demo account uses the password: ${DEMO_PASSWORD}
Sign in as any of:
  ${[...created, ...reviewers].map((u) => u.username).join(',  ')}

These are demo credentials — change or delete them before opening the site publicly.
`);
  await pool.end();
  process.exit(0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});