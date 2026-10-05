function handler(event) {
  var request = event.request;
  var uri = request.uri || '/';

  // The marketing landing is a real static document.
  if (uri === '/') {
    request.uri = '/index.html';
    return request;
  }

  // Axoview's editor is one SPA rooted at /app. Deep links such as
  // /app/display/<id> must return app.html rather than a 404 from S3.
  if (uri === '/app' || uri.indexOf('/app/') === 0) {
    var last = uri.substring(uri.lastIndexOf('/') + 1);
    if (uri === '/app' || last.indexOf('.') === -1) {
      request.uri = '/app.html';
    }
    return request;
  }

  // Preserve the clean-URL behavior of the existing nginx/Pages deployment
  // for static top-level pages such as /privacy -> /privacy.html.
  var leaf = uri.substring(uri.lastIndexOf('/') + 1);
  if (uri.charAt(uri.length - 1) !== '/' && leaf.indexOf('.') === -1) {
    request.uri = uri + '.html';
  }

  return request;
}
