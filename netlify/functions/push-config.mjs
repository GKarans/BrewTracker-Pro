export default async () => {
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  if (!publicKey) {
    return Response.json({ error: "Web Push nav konfigurēts." }, { status: 503 });
  }
  return Response.json({ publicKey }, {
    headers: { "cache-control": "public, max-age=3600" },
  });
};

