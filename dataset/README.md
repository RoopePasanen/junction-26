# Dataset and training

## Folders
| Folder | What |
|---|---|
| `raw/` | Image batches as delivered (unzipped, untouched, with their `manifest.csv`) |
| `ei_upload/train/` | **Training set**: AI-generated images, renamed `<label>.<name>.jpg` |
| `ei_upload/test/` | **Real-camera test set**: our own UNO Q camera shots (`warn_animal/` minus the junk frames) |
| `warn_animal/` | Original camera shots (source of the test set) |
| `tools/ei.js` | Add, count and upload images (Node only, no installs) |

## Adding new images (e.g. a new Gemini batch)
Put them in class folders (`warn_animal/`, `small_animal/`, `no_animal/`) or name them `<class>_...jpg`, then:

```bash
node dataset/tools/ei.js add "C:/Users/roope/Downloads/new-batch.zip"
node dataset/tools/ei.js upload
```

`add` accepts a zip or a folder, skips images it already has (by content hash), and prints the per-class counts.
`upload` sends everything in `ei_upload/train` to Edge Impulse, which skips images it already has. After uploading, click **Retrain model** in Edge Impulse.
Add `--test` to either command for real-camera test images.

## Edge Impulse (one-time setup)
1. Create a project at studio.edgeimpulse.com. Go to **Dashboard > Keys**, copy the API key and put it in `dataset/.env` (this file is git-ignored):
   ```
   EI_API_KEY=ei_...
   ```
2. Upload the images:
   ```bash
   node dataset/tools/ei.js upload
   node dataset/tools/ei.js upload --test
   ```
3. **Create impulse**: Image data 96×96, resize mode "Fit shortest axis". Add an **Image** processing block and a **Transfer Learning (Images)** learning block. Save.
4. **Image** block: colour depth **RGB**, then **Save parameters > Generate features**.
5. **Transfer learning**: MobileNetV2 96×96 0.35, 30 epochs, learning rate 0.0005, **data augmentation on**. Under Advanced, tick **Auto-balance dataset**, because no_animal has fewer images. Train.
6. **Model testing > Classify all**: accuracy on the real camera shots. These numbers go in the pitch (step A7 in the plan).
7. **Deployment**: Arduino UNO Q, or **Linux (AARCH64)**, which gives an `.eim` file. Copy it to the board's `~/.arduino-bricks/ei-models/`.

Note: the current test set has only `warn_animal` camera shots, so it measures whether real animals get caught, not false alarms. Add camera shots of people, cars or empty scenes with `--test` when there's time.
