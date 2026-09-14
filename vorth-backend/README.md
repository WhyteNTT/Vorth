# Vorth Backend

Node.js + Express + MongoDB API for the Vorth novel/comic reading
platform. Ships with **no mock or seed data** — the catalog is empty
until a real user publishes something.

> **Legal notice:** the `/legal` folder contains *template* Terms of
> Service, Privacy Policy, DMCA Policy, Copyright Guidelines, and
> Content Policy documents. They are functionally complete drafts,
> not legal advice, and have not been reviewed by an attorney. Have
> them reviewed by counsel — and register a DMCA designated agent
> with the U.S. Copyright Office — before operating this publicly.
> See `legal/DMCA_POLICY.md` for details.

## 1. Setup

```bash
cd vorth-backend
npm install
cp .env.example .env
# edit .env — at minimum set MONGO_URI and JWT_SECRET
npm run dev        # nodemon, auto-restarts on change
# or
npm start          # plain node
```

Requires Node 18+ and a running MongoDB instance (local or Atlas).

If you were previously running an earlier prototype with mock books,
clear it with:

```bash
npm run db:wipe -- --confirm
```

## 2. Project structure

```
server.js                  entry point: connects DB, starts Express, registers cron jobs
src/
  app.js                   Express app: security middleware, routes, error handling
  config/
    env.js                 loads & validates environment variables
    db.js                  Mongoose connection
  models/                  User, Series, Chapter, Comment, ReadingProgress, Notification, DMCAReport
  controllers/              request handlers, one file per resource
  routes/                   route definitions, mounted under /api in routes/index.js
  middleware/
    auth.js                 JWT verification (protect, optionalAuth, restrictTo)
    ownership.js             enforces "only the publishing creator can add chapters"
    upload.js                multer config for cover/page images
    rateLimiter.js           general + auth-specific rate limits
    errorHandler.js          centralized error formatting
  jobs/
    resetViews.js            cron: resets daily/weekly view counters (drives rankings)
  utils/                     asyncHandler, ApiError, generateToken, validate
scripts/
  wipeDatabase.js            clears Series/Chapter (and optionally Comment/User) collections
legal/                       Terms, Privacy, DMCA, Copyright, Content Policy templates
uploads/                     uploaded cover images & comic pages (served at /uploads/*)
```

## 3. Authentication

JWT bearer tokens. Register or log in to get a token, then send it as:

```
Authorization: Bearer <token>
```

Registration requires `agreedToTerms: true` and `ageConfirmed: true`
in the request body — these map to the Terms of Service and minimum
age requirement.

## 4. Ownership model

Anyone can browse and read the catalog without an account. Publishing
requires sign-in. **Only the account that published a series can add
chapters to it** — enforced server-side by the `requireSeriesOwner`
and `requireChapterOwner` middleware, not just hidden in the UI.

## 5. API reference

Base URL: `/api`

### Auth — `/auth`
| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/auth/register` | — | Create account. Body: `displayName, username, email, password, agreedToTerms, ageConfirmed` |
| POST | `/auth/login` | — | Body: `identifier` (username or email), `password` |
| GET | `/auth/me` | ✓ | Current user |
| PATCH | `/auth/me` | ✓ | Update `displayName`/`bio` |
| PATCH | `/auth/me/password` | ✓ | Body: `currentPassword, newPassword` |

### Series — `/series`
| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/series` | — | Browse/search. Query: `type, genre, status, tag, q, sort(popular|rating|newest|az), page, limit` |
| GET | `/series/rankings` | — | Query: `range(daily|weekly|alltime)` |
| GET | `/series/:id` | — | Full detail + chapter list + comment count |
| POST | `/series` | ✓ | Publish a series. Requires `rightsAttested: true` |
| PATCH | `/series/:id` | ✓ owner | Update series fields |
| DELETE | `/series/:id` | ✓ owner | Soft-delete |
| POST | `/series/:seriesId/chapters` | ✓ owner | Publish a chapter (novel: `paragraphs[]`, comic: `pages[]`) |
| GET | `/series/:seriesId/comments` | — | List reviews |
| POST | `/series/:seriesId/comments` | ✓ | Body: `rating(1-5), text, parent?` |

### Chapters — `/chapters`
| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/chapters/:id` | — | Read a chapter (increments view counters) |
| PATCH | `/chapters/:id` | ✓ owner | Edit |
| DELETE | `/chapters/:id` | ✓ owner | Soft-delete |

### Comments — `/comments`
| Method | Path | Auth | Description |
|---|---|---|---|
| DELETE | `/comments/:id` | ✓ author/admin | Remove a comment |

### Library — `/library` (all require auth)
| Method | Path | Description |
|---|---|---|
| GET | `/library` | Saved series |
| POST | `/library/:seriesId` | Save |
| DELETE | `/library/:seriesId` | Unsave |
| GET | `/library/downloads` | Chapters marked offline |
| POST | `/library/downloads` | Body: `seriesId, chapterId` |
| DELETE | `/library/downloads/:chapterId` | Remove offline mark |

### Progress — `/progress` (all require auth)
| Method | Path | Description |
|---|---|---|
| GET | `/progress` | Full reading history |
| GET | `/progress/:seriesId` | Resume point for one series |
| PUT | `/progress/:seriesId` | Body: `chapterId, scrollPct?, page?, bookmarked?` |
| DELETE | `/progress/:seriesId` | Clear |

### Notifications — `/notifications` (all require auth)
| Method | Path | Description |
|---|---|---|
| GET | `/notifications` | List + unread count |
| PATCH | `/notifications/:id/read` | Mark one read |
| PATCH | `/notifications/read-all` | Mark all read |

### Uploads — `/uploads` (require auth)
| Method | Path | Description |
|---|---|---|
| POST | `/uploads/cover` | multipart field `cover` → `{ path }` |
| POST | `/uploads/pages` | multipart field `pages` (multiple) → `{ paths[] }` |

### DMCA — `/dmca`
| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/dmca` | — (public) | File a takedown notice |
| GET | `/dmca` | admin | List reports |
| GET | `/dmca/:id` | admin | Report detail |
| PATCH | `/dmca/:id` | admin | Resolve: `status(under_review|accepted|rejected), adminNotes?` — `accepted` soft-removes the target content |

### Admin — `/admin` (admin role required)
| Method | Path | Description |
|---|---|---|
| GET | `/admin/users` | List users |
| PATCH | `/admin/users/:id/ban` | Body: `reason?` |
| PATCH | `/admin/users/:id/unban` | — |
| DELETE | `/admin/series/:id` | Moderation removal |
| DELETE | `/admin/comments/:id` | Moderation removal |

### Legal — `/legal`
| Method | Path | Description |
|---|---|---|
| GET | `/legal` | List available documents |
| GET | `/legal/:doc` | Serves `terms`, `privacy`, `dmca`, `copyright`, or `content` as markdown |

### Health
`GET /api/health` → `{ success, status: 'ok', time }`

## 6. Making the first admin user

There's no signup flow for admins on purpose. After registering a
normal account, promote it manually:

```js
// mongo shell / Compass
db.users.updateOne({ username: "your_username" }, { $set: { role: "admin" } })
```

## 7. Known limitations / what's next

- **No refresh tokens** — a single JWT with an expiry set by
  `JWT_EXPIRES_IN`. "Logout" is client-side token discard.
- **No email verification or password reset flow** — worth adding
  before real users rely on this.
- **No payment/monetization** — out of scope for this pass.
- **No dedicated "report content" endpoint** for non-copyright
  Content Policy violations — only DMCA has a formal intake right now.
- **No DMCA counter-notice flow** — accepted takedowns are final in
  the current implementation; a real platform typically needs to
  support counter-notices with the statutory waiting period.
- **Uploads are stored on local disk** (`/uploads`) — fine for a
  single server, but you'll want S3/GCS/Cloudinary or similar before
  scaling past one instance.
- The legal documents in `/legal` are templates — see the notice at
  the top of this file.
