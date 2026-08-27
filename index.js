export default function index(_request, response) {
  response.status(404).setHeader("Content-Type", "application/json; charset=utf-8").json({
    error: {
      code: "NOT_FOUND",
      message: "Use POST /analyze-image.",
    },
  });
}
