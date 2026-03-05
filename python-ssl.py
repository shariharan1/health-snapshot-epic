from http.server import HTTPServer, SimpleHTTPRequestHandler
import ssl

server_address = ('localhost', 3443)
httpd = HTTPServer(server_address, SimpleHTTPRequestHandler)

context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
context.load_cert_chain(certfile='C:/Workplace/Playground/Cert-dev/python-dev-cert.pem', keyfile='C:/Workplace/Playground/Cert-dev/python-dev-cert-key.pem')
httpd.socket = context.wrap_socket(httpd.socket, server_side=True)

print("Serving HTTPS on https://localhost:4443")
httpd.serve_forever()