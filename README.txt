RELIEF REVEAL EFFECT
====================

To run:
  - serve this folder over HTTP (it will NOT work from file://), e.g.:
      * VS Code "Live Server" extension  → open index.html
      * or:  python -m http.server 8000  → http://localhost:8000/
  - internet connection is required (three.js loads from CDN)

Move the cursor over the wall to reveal the relief. Scroll to travel.

Files:
  index.html + main.js   the app
  bakes/                 the 3D model and pre-baked light textures
  assets/                plaster / noise textures used by the shaders
