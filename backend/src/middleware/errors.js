const notFoundHandler = (req, res) => {
  res.status(404).json({ error: "Not found" });
};

const errorHandler = (err, req, res, next) => {
  const status = err.status || 500;
  if (status >= 500) {
    // eslint-disable-next-line no-console
    console.error(err);
  }
  res.status(status).json({ error: err.message || "Internal server error" });
};

module.exports = {
  notFoundHandler,
  errorHandler,
};
