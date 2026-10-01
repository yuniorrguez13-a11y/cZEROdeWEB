# cZEROde 2

**Your stuff. Locked.** cZEROde is a private vault for your photos, videos, music, documents and notes. It
encrypts everything right on your device. No accounts, no servers, no cloud: nothing you put in it ever leaves
your phone or computer unless you send it yourself.

What it does:

- **🔒 Vault:** hide photos, videos, music, files and notes in an encrypted vault. Look at them, play them and
  sort them into albums inside the app, without decrypted copies lying around in your files.
- **Send · Open:** lock one or more files into a single passphrase-protected `.czd` file. Send it over
  WhatsApp, Discord, email or a USB stick. The other person opens it with the passphrase, in the browser or in
  the app.
- **Text:** the classic cZEROde camouflage messages. Your text turns into what looks like Georgian and Cyrillic
  script (`ჶაჰთსГПЗСЛცУУЫНЧ…`), now with modern encryption underneath.
- **Legacy:** everything from cZEROde 1 still opens: old messages, the old web vault and old desktop `.czd`
  files. You can bring all of it into the new vault.

---

## Where to get it

- **In your browser (any device):** <https://yuniorrguez13-a11y.github.io/cZEROdeWEB/>. Nothing to download.
  On a phone, [install it as an app](#install-it-on-your-phone) for the best experience.
- **Desktop app (Windows, macOS, Linux):** download the installer from the
  [Releases page](https://github.com/yuniorrguez13-a11y/cZEROdeWEB/releases). Builds that haven't been released
  yet are under the repository's **Actions** tab → "Desktop build" → a green run → **Artifacts** (you need to
  be signed in to GitHub to download those). See [Desktop notes](#desktop-notes) before you install.

Supported browsers: Chrome or Edge 108+, Firefox 115+, Safari 16.4+ (iPhone/iPad included).

---

## Quick start

### 1. Create your vault

1. Open cZEROde and tap **Hide my photos & files**.
2. Pick a passphrase. Tap **Generate** to get 5 random words, which is the easy and strong option. Save them
   somewhere: a password manager, paper, or a screenshot you keep safe.
3. Tick the boxes and tap **Create vault**.
4. cZEROde shows you a **recovery code** (8 groups of 4 characters). Copy it or download it as a `.txt` and keep
   it somewhere safe, **away from this device**. It's your way back in if you ever forget the passphrase.
   Anyone who has it can open your vault, so treat it like a key.

If you forget your passphrase **and** lose your recovery code, your files are gone. Nobody can get them back,
not even us. That's the point. 💀

### 2. Add your stuff

In the vault, tap **Add files**, drag files or folders onto the window, or paste an image. Everything is
encrypted on your device as it comes in. Make albums, star favourites, write notes, play your music.

Your originals stay where they were (your Photos, your Downloads). Once you've made a backup, delete them there
if you only want them in the vault.

### 3. Send a file to someone

1. Go to **Send · Open** (called **Share** on phones), then **Lock files to send**, and pick your files.
   From the vault, you can also open a file's menu and choose **Send as .czd**.
2. cZEROde makes up a 6-word passphrase for you. You can tap **Use my own** instead.
3. Tap **Lock & save**. Several files become one `.czd`.
4. Send the `.czd` however you like.
5. Send the **passphrase through a different app** than the file, or just say it out loud.
   **Copy message for the receiver** gives you a ready-made note with the link to open it.

### 4. Open a `.czd` someone sent you

Open **Send · Open → Open a .czd** (or go straight to
<https://yuniorrguez13-a11y.github.io/cZEROdeWEB/#/open>). Pick the file and type the passphrase. You can then
preview it, save it, or **Add to my vault**. Nobody needs an account or an install for this.

### 5. Back up

Go to **More → Settings → Vault → Export backup**. You get one `.czb` file with everything in your vault, still
encrypted. It opens with your passphrase or your recovery code. Keep a copy somewhere other than this device: a
USB stick or a cloud drive is fine. cZEROde reminds you when your last backup is more than a week old.

To get it back, tap **I have a backup (.czb)** on a fresh install. If that device already has a vault, use
**Settings → Merge backup**, which adds the backup's items to it.

### Bonus: secret messages

On the **Text** tab, type a message and a passphrase, then tap **Encrypt** and copy the funky-looking result.
Your friend pastes it into the Text tab, types the same passphrase, and gets your message back. (Try encrypting
the word `codzilla`. Just saying.)

---

## Install it on your phone

Installing gives cZEROde its own icon and window. It also works offline, and the browser is much less likely to
clear your vault.

**Android (Chrome, Edge, Samsung Internet):**

1. Open <https://yuniorrguez13-a11y.github.io/cZEROdeWEB/>.
2. Tap **More → Install app**, or open the browser menu (⋮) and choose **Install app** / **Add to Home screen**.
3. Open cZEROde from your home screen.

**iPhone / iPad (Safari): install first, then create your vault.**

1. Open <https://yuniorrguez13-a11y.github.io/cZEROdeWEB/> in **Safari**.
2. Tap **Share** (the square with the arrow), then **Add to Home Screen**.
3. Open cZEROde **from your Home Screen** and create your vault there.

Why first? On iPhone and iPad, the installed app and the Safari tab keep **separate** storage. A vault made in
a Safari tab doesn't show up in the installed app, and Safari can erase a tab's data after 7 days without use.
If you already made a vault in a Safari tab, export a backup there first and restore it inside the installed
app.

---

## What's protected (and what isn't)

**Protected:**

- your vault on your device: contents, names, types and sizes are all encrypted, and changes are detected;
- `.czd` files while they travel;
- your text messages.

All of it uses AES-256-GCM, with keys from your passphrase through Argon2id.

**Not protected:**

- a weak passphrase (cZEROde warns you);
- malware or keyloggers on your device;
- someone using your phone while the vault is unlocked;
- your browser or OS being compromised.

Someone with your device can also see *how many* items you have and roughly how big they are.

Two things about the web version:

- It lives on a GitHub Pages address (`yuniorrguez13-a11y.github.io`) that any other Pages site of the same
  GitHub account would share, which is why there must never be one.
- Like any web app, it trusts GitHub to deliver the right code.

The desktop app has its own address.

The whole honest story, including the technical details: **[SECURITY.md](SECURITY.md)**. Inside the app:
**More → About & security**.

---

## Coming from cZEROde 1?

Your old stuff is safe. cZEROde 2 never deletes it on its own.

- **Old web vault** (notes, files, playlists). Open the new app in the **same browser** at the same address. It
  notices your old data and shows *"Coming from cZEROde 1? Your old stuff is safe →"*. Then:
  1. Go to **More → Legacy → Old web vault** and unlock with your old PIN (you can try several PINs).
  2. Preview or save items one by one, or create/unlock your new vault and tap **Import all unlocked**. Playlists
     become albums.
  3. Once everything is in, you can tap **Delete old data**. cZEROde offers a backup first.
- **Old messages** (Mixed Script v1–v3 and the cZEROde v4 AES text). Paste them into **More → Legacy → Old
  messages**. cZEROde works out which version it is and asks for the PIN when needed. The Text tab also decrypts
  old v4 messages directly.
- **Old desktop app** (`.czd` image files). The new desktop app finds them automatically under **Legacy → Old
  desktop .czd files**. On the web, pick the files there.

A heads-up: Mixed Script v1–v3 were never real encryption, and v4 used a weak PIN-based key. Once your old
things are in the new vault, they get the new, strong protection. Spotdown is gone in 2.0.

---

## Desktop notes

The installers aren't code-signed (signing certificates cost money), so your OS warns you the first time. They
are built straight from this repository by GitHub Actions. Only download them from the
[Releases page](https://github.com/yuniorrguez13-a11y/cZEROdeWEB/releases) or this repo's Actions runs.

- **Windows** (`.exe` installer): if SmartScreen says *"Windows protected your PC"*, click **More info**, then
  **Run anyway**. The app installs for your user only.
- **macOS** (Apple silicon `.dmg`): drag cZEROde to Applications and open it once. When macOS refuses, go to
  **System Settings → Privacy & Security**, scroll down and click **Open Anyway** next to cZEROde. If macOS says
  the app *"is damaged and can't be opened"*, run this in Terminal once and open it again:
  `xattr -dr com.apple.quarantine /Applications/cZEROde.app`. macOS 12 or newer is required.
- **Linux** (`.deb` or AppImage):
  - Install the `.deb` with `sudo apt install ./czeroode_*.deb` (the package is called `czeroode`; remove it
    with `sudo apt remove czeroode`).
  - For the AppImage, make it executable (`chmod +x`) and run it.
  - To play audio and video, have `gstreamer1.0-plugins-good` and `gstreamer1.0-libav` installed.
  - On Linux the desktop app plays audio and video previews from memory, up to 512 MB per file. For bigger files,
    use **Save decrypted copy** and play them with your own player.
- There's no auto-update. **More → Get the latest version** opens the Releases page.

---

## FAQ

**I forgot my passphrase.**
On the lock screen, tap **Forgot it?**, then **Use recovery code**. Enter your recovery code and pick a new
passphrase. Without the recovery code there's no way back in. Your only option then is **Delete vault and start
over**. If you have an older backup, it still opens with the passphrase that was current when you made it.

**I lost my recovery code but I still know my passphrase.**
Go to **Settings → Vault → Recovery code → Replace code**. You'll need your passphrase.

**Why don't I see my vault on my other phone / in another browser?**
There's no account and no sync. Every browser and every app install has its **own** vault, and the installed
iPhone app and Safari count as separate too.

**How do I move my vault to a new device?**
Export a backup (`.czb`) on the old device, copy the file over, then choose **I have a backup (.czb)** on the new
one. If the new device already has a vault, use **Settings → Merge backup** instead. For a few files, you can
also send them to yourself as a `.czd` and tap **Add to my vault** on the other side.

**Does the person I send a `.czd` to need cZEROde?**
They just need a browser. They open <https://yuniorrguez13-a11y.github.io/cZEROdeWEB/#/open> and type the
passphrase.

**Does cZEROde upload anything?**
No. It makes no network requests at all. Everything happens on your device.

**The app says "Not protected from cleanup" or "Private window".**
Browsers may clear website data when space runs low, and private windows forget everything when you close them.
Tap **Keep my data**, install the app, and keep a recent backup.

**A huge video won't play or save on my phone.**
Phones have less memory, so very large files may be "too big to play or save on this device". They're still
safely in your vault. Open them on a computer, or send them as a `.czd`. Saving very large decrypted files also
doesn't work in Safari, so use Chrome or the desktop app.

**I changed my passphrase. Is my old one dead?**
On this device, yes. But anyone who already has a copy of your vault or an old backup can still open that copy
with the old passphrase.

---

## For developers

cZEROde is a static app with no build step. The same files run on GitHub Pages and inside the Tauri 2 desktop
app. Here's where to look:

- Running it locally, tests, the desktop build, CI, releases and Pages: [docs/DEVELOPING.md](docs/DEVELOPING.md).
- File formats (`.czd`, `.czb`, text v2, vault storage, legacy): [docs/FORMAT.md](docs/FORMAT.md).
- Security model: [SECURITY.md](SECURITY.md). To report a vulnerability, see the
  [instructions there](SECURITY.md#reporting-a-vulnerability).
