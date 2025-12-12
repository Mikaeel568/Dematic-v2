from flask import Flask, send_from_directory, Response
import os

app = Flask(__name__, static_folder=".")

@app.route("/")
def index():
    return send_from_directory(".", "index.html")

@app.route("/<path:path>")
def static_files(path):
    return send_from_directory(".", path)

@app.route("/logs")
def get_logs():
    log_path = os.path.join("backend", "logs", "warehouse.log")
    try:
        with open(log_path, "r") as file:
            data = file.read()
        return Response(data, mimetype="text/plain")
    except:
        return Response("ERROR: Cannot read warehouse.log", status=500)

if __name__ == "__main__":
    print("✅ Python backend running at http://localhost:8000")
    app.run(port=8000, debug=True)
