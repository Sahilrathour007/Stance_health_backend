# Stance Health Backend

Thin Express backend for Supabase Auth, Postgres data access, risk scoring, onboarding state, and doctor dashboard payloads.

## Run

```bash
npm install
npm run dev
```

Server: `http://localhost:4000`

## Core Endpoints

- `POST /auth/register`
- `POST /auth/login`
- `GET /auth/me`
- `POST /onboarding/start`
- `PUT /onboarding/:patientId/step/:stepNumber`
- `POST /onboarding/:patientId/complete`
- `POST /check-ins`
- `GET /doctor/dashboard`
- `GET /patients/:id`
- `GET /patients/:id/check-ins`
- `POST /appointments`

Use `Authorization: Bearer <access_token>` for protected routes. The access token comes from `/auth/login`.

## Security

The service-role key is only in `.env` for server-side privileged actions. Do not copy it into any frontend file.
