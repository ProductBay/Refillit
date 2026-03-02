require("./config/env");

const migrator = {
  async up() {
    return [];
  },
};

const run = async () => {
  await migrator.up();
};

if (require.main === module) {
  run()
    .then(() => {
      // eslint-disable-next-line no-console
      console.log("Migrations completed");
      process.exit(0);
    })
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error("Migration failed", err);
      process.exit(1);
    });
}

module.exports = { migrator };
