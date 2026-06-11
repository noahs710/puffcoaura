const http = require('http');
const fs = require('fs');
const path = require('path');
const port = 8420;
const mimeTypes = {'.html':'text/html','.js':'application/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml'};
const server = http.createServer((req, res) => {
  let urlPath = req.url.split('?')[0];
  let filePath = path.join(__dirname, urlPath === '/' ? 'index.html' : urlPath);
  try {
    const content = fs.readFileSync(filePath);
    res.writeHead(200, {'Content-Type': mimeTypes[path.extname(filePath)] || 'text/plain'});
    res.end(content);
  } catch(e) {
    res.writeHead(404);
    res.end('Not found: ' + req.url);
  }
});
server.listen(port, () => console.log('Server on http://127.0.0.1:' + port));
