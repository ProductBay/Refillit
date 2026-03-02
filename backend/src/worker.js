require("./config/env");

const { sequelize } = require("./db");
const { initModels } = require("./models");
const { processOutbox } = require("./utils/notificationProcessor");

const intervalMs = Number(process.env.NOTIFY_POLL_INTERVAL_MS || 10000);
const provider = process.env.NOTIFY_PROVIDER || "mock";

const run = async () => {
  initModels();
  await sequelize.authenticate();

  // eslint-disable-next-line no-console
  console.log(`Notification worker started (provider=${provider})`);

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await processOutbox({ provider });
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error("Notification worker error", error);
    }
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
};

if (require.main === module) {
  run().catch((error) => {
    // eslint-disable-next-line no-console
    console.error("Worker failed", error);
    process.exit(1);
  });
}
