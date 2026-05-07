const express = require('express');
const cors = require('cors');

const authRoutes = require('./src/routes/auth.routes');
const onboardingRoutes = require('./src/routes/onboarding.routes');
const checkInRoutes = require('./src/routes/checkins.routes');
const doctorRoutes = require('./src/routes/doctor.routes');
const patientRoutes = require('./src/routes/patient.routes');
const appointmentRoutes = require('./src/routes/appointments.routes');
const treatmentPlanRoutes = require('./src/routes/treatmentPlans.routes');
const notificationRoutes = require('./src/routes/notifications.routes');
const publicRoutes = require('./src/routes/public.routes');

const app = express();

const corsOrigin = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(',').map((origin) => origin.trim()).filter(Boolean)
  : '*';

app.use(cors({ origin: corsOrigin }));
app.use(express.json({ limit: '1mb' }));

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'stance-health-backend' });
});

function registerApiRoutes(prefix = '') {
  app.use(`${prefix}/public`, publicRoutes);
  app.use(`${prefix}/auth`, authRoutes);
  app.use(`${prefix}/onboarding`, onboardingRoutes);
  app.use(`${prefix}/check-ins`, checkInRoutes);
  app.use(`${prefix}/doctor`, doctorRoutes);
  app.use(`${prefix}/patients`, patientRoutes);
  app.use(`${prefix}/appointments`, appointmentRoutes);
  app.use(`${prefix}/treatment-plans`, treatmentPlanRoutes);
  app.use(`${prefix}/notifications`, notificationRoutes);
}

registerApiRoutes();
registerApiRoutes('/api');

app.use((req, res) => {
  res.status(404).json({ error: 'Not found', path: req.originalUrl });
});

app.use((err, _req, res, _next) => {
  const isJsonParseError = err instanceof SyntaxError && err.status === 400 && 'body' in err;
  const isValidationError = err.name === 'ZodError';
  const status = isJsonParseError || isValidationError ? 400 : err.status || 500;
  console.error(err);
  res.status(status).json({
    error: isValidationError ? 'Validation failed' : err.message || 'Internal server error',
    details: isValidationError ? err.issues : err.details
  });
});

module.exports = app;
