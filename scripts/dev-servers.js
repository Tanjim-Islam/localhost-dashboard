// Spin up a few local HTTP servers for testing discovery
const http = require('http');

function startServer(port, name) {
  const started = Date.now();
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(`${name} on ${port} up ${(Date.now() - started) / 1000}s\n`);
  });
  srv.listen(port, '127.0.0.1', () => console.log(`[test] ${name} listening on :${port}`));
}

startServer(3000, 'vite-like');
startServer(5173, 'vite');
startServer(8080, 'api');

