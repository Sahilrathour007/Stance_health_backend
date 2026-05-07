require('dotenv').config();

const app = require('./app');

const port = process.env.PORT || 4000;

app.listen(port, () => {
  console.log(`Stance Health backend listening on http://localhost:${port}`);
});
