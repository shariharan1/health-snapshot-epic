from http.server import HTTPServer, SimpleHTTPRequestHandler
import ssl
import json

with open('config.json', 'r') as f:
    config = json.load(f)

port = config.get("port", 3443)

server_address = ('localhost', port)
httpd = HTTPServer(server_address, SimpleHTTPRequestHandler)

context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
context.load_cert_chain(certfile='C:/Workplace/Playground/Cert-dev/python-dev-cert.pem', keyfile='C:/Workplace/Playground/Cert-dev/python-dev-cert-key.pem')
httpd.socket = context.wrap_socket(httpd.socket, server_side=True)

print(f"Serving HTTPS on https://localhost:{port}")
httpd.serve_forever()