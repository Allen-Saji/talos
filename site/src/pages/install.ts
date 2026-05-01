/* Plaintext install endpoint for agents and curl pipelines.
   Returns the canonical install command, no HTML, no markup. */

export const prerender = true;

export const GET = () =>
  new Response('npx talos init\n', {
    status: 200,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=60',
      'X-Talos-Channel': 'install',
    },
  });
