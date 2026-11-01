# Notes page source

`notes.html` at the top of this repo is **built** from this folder. Change the source here, then rebuild,
so the next change doesn't undo yours (editing the built file directly gets lost the next time someone builds).

```
cd notes-src
npm ci
node build.mjs          # writes dist/notes.html
cp dist/notes.html ../notes.html
```

The same `notes.html` serves reelcall.app/notes.html and the Drawer (drawer.studiostrong.fit/notes,
which pulls the latest from GitHub about once an hour).
