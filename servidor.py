"""Servidor local de la pagina Desk-Mate: python servidor.py  ->  http://localhost:8080"""
import http.server
import sys
import webbrowser
from pathlib import Path
from functools import partial


class Manejador(http.server.SimpleHTTPRequestHandler):
    # en Windows el registro puede asociar .js a text/plain y romper los modulos
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map,
                      ".js": "text/javascript", ".task": "application/octet-stream"}

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()


if __name__ == "__main__":
    direccion = "http://localhost:8080"
    servidor = http.server.ThreadingHTTPServer(
        ("127.0.0.1", 8080), partial(Manejador, directory=str(Path(__file__).resolve().parent)))
    print("Desk-Mate en", direccion, "(Ctrl+C para cerrar)")
    if "--abrir" in sys.argv:
        webbrowser.open(direccion)
    servidor.serve_forever()
