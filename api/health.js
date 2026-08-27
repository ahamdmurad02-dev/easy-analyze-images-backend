export default function health(_request, response) {
  response.status(200).setHeader("Cache-Control", "no-store").json({ status: "ok" });
}
