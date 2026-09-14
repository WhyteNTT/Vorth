# Vorth

Vorth is a novel and comic reading platform with a separate frontend and
Express/MongoDB backend.

## Project layout

- [`vorth-backend/`](./vorth-backend/) - Node.js API, authentication, catalog,
  uploads, moderation, and legal/DMCA endpoints.
- [`vorth-frontend/`](./vorth-frontend/) - static browser frontend.

## Run locally

1. Configure [`vorth-backend/.env.example`](./vorth-backend/.env.example) as
   `vorth-backend/.env`, including a MongoDB URI and a long JWT secret.
2. Run `npm install` and `npm run dev` from `vorth-backend/`.
3. Open the frontend from a local static server, or use the API's static
   serving when running the backend.

See [`vorth-backend/README.md`](./vorth-backend/README.md) for the API
reference and operational notes.
