require("./config/env");

const http = require("http");

const { app } = require("./app");
const { sequelize } = require("./db");
const { runMigrations } = require("./db/migrate");
const { initModels } = require("./models");
const { createChatServer } = require("./chat/ws");
const { seedUsers } = require("./seed");

const port = Number(process.env.PORT || 4000);

const startServer = async () => {
  try {
    await initModels();
    await sequelize.authenticate();
    await runMigrations();
    if (process.env.NODE_ENV !== "test" && process.env.AUTO_SEED_DEMO !== "false") {
      await seedUsers();
    }

    const server = http.createServer(app);
    createChatServer(server);
    server.listen(port, () => {
      console.log(`Refillit API listening on port ${port}`);
    });
  } catch (error) {
    console.error("Failed to start server", error);
    process.exit(1);
  }
};

startServer();
