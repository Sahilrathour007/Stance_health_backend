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

const app = express();

app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));
app.use(express.json({ limit: '1mb' }));

app.get('/', (_req, res) => {
  res.send('Stance Health Backend Running');
});

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'stance-health-backend' });
});

app.use('/auth', authRoutes);
app.use('/onboarding', onboardingRoutes);
app.use('/check-ins', checkInRoutes);
app.use('/doctor', doctorRoutes);
app.use('/patients', patientRoutes);
app.use('/appointments', appointmentRoutes);
app.use('/treatment-plans', treatmentPlanRoutes);
app.use('/notifications', notificationRoutes);

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
