// Service-worker side of encrypted media streaming (classic script imported by sw.js; DESIGN §5.2).
// Exposes self.czStream.handle(event) for /czstream/ requests.
// Owner: F (phase 2). Phase-0 placeholder: every request gets 501.
self.czStream = {
  handle() {
    return new Response(null, { status: 501 });
  },
};
