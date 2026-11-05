// Settings → Other devices (desktop app only): open Kokon in a browser on a phone, tablet or
// laptop on the same network. Off until the user sets a password and turns it on; the service
// opens the network port only then (crates/qls-service/src/remote.rs).

import { CirclePlay, Copy, ExternalLink } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { encode } from "uqr";
import { api, type RemoteStatus } from "../lib/api";
import { native } from "../lib/native";
import { VIDEOS } from "../lib/videos";
import { toastError, toastInfo } from "../lib/store";
import { Switch } from "./ui";

const GUIDE_URL = "https://github.com/GabrieleLozupone/kokon/blob/master/docs/remote-access.md";

/** The address as a QR code for the phone's camera: black on white in both themes, so every scanner reads it. */
function QrCode({ text }: { text: string }) {
  const { path, size } = useMemo(() => {
    const qr = encode(text, { border: 2 });
    let d = "";
    qr.data.forEach((row, y) => row.forEach((on, x) => on && (d += `M${x} ${y}h1v1h-1z`)));
    return { path: d, size: qr.size };
  }, [text]);
  return (
    <svg className="qr" viewBox={`0 0 ${size} ${size}`} role="img" aria-label={`QR code for ${text}`} shapeRendering="crispEdges">
      <rect width={size} height={size} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  );
}

function PasswordForm({ status, onSaved }: { status: RemoteStatus; onSaved: (s: RemoteStatus) => void }) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const short = password.length > 0 && password.length < status.min_password_chars;
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (short || !password) return;
    setBusy(true);
    try {
      const first = !status.password_set;
      let s = await api.setRemotePassword(password);
      // Setting the first password is the step before turning access on: do both.
      if (first && !s.enabled) s = await api.setRemote(true);
      setPassword("");
      onSaved(s);
      toastInfo(first ? "Password set" : "Password changed. Other devices sign in again.");
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="field" onSubmit={save}>
      <span>{status.password_set ? "Change the password" : "Choose a password"}</span>
      <div className="path-row">
        <input
          className="input"
          type="password"
          autoComplete="new-password"
          placeholder={`At least ${status.min_password_chars} characters`}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <button className="btn primary" type="submit" disabled={!password || short || busy}>
          {status.password_set ? "Change" : "Set and turn on"}
        </button>
      </div>
      <span className="muted">
        {short ? `At least ${status.min_password_chars} characters.` : "Each browser asks for it once. Stored only as a secure hash on this computer."}
      </span>
    </form>
  );
}

export function RemoteAccess() {
  const [st, setSt] = useState<RemoteStatus | null>(null);
  const [port, setPort] = useState("");
  useEffect(() => {
    api.remote().then((s) => (setSt(s), setPort(String(s.port))), toastError);
  }, []);
  if (!st) return null;

  const toggle = async (on: boolean) => {
    try {
      const p = Number(port);
      setSt(await api.setRemote(on, Number.isInteger(p) && p >= 1024 && p <= 65535 ? p : undefined));
    } catch (e) {
      toastError(e);
    }
  };
  const removePassword = async () => {
    if (!(await native.confirm("Remove the password? Access from other devices turns off, and every browser is signed out.", "Remove password"))) return;
    try {
      setSt(await api.removeRemotePassword());
    } catch (e) {
      toastError(e);
    }
  };

  return (
    <>
      <span className="muted">
        Open Kokon in a browser on your phone, tablet or another computer on the same network. Images are made on this computer and saved in its gallery; each device can download
        them.
      </span>
      {!st.password_set ? (
        <PasswordForm status={st} onSaved={setSt} />
      ) : (
        <>
          <div className="field-row">
            <span>Allow access from other devices</span>
            <Switch on={st.enabled} onChange={toggle} />
          </div>
          {st.forced && <span className="muted">Turned on for this run by kokon-service --remote.</span>}
          {st.listening && st.url && (
            <div className="setting-card remote-open">
              <QrCode text={st.url} />
              <div className="setting-card-text">
                <strong>Scan it with your phone's camera</strong>
                <span className="muted">
                  Or open <span className="remote-url">{st.url}</span> on the other device. To keep Kokon on the home screen like an app: on iPhone, Share → Add to Home Screen; on
                  Android, the browser's menu → Add to Home screen. The router can give this computer another address later: reserve it in the router's settings (DHCP
                  reservation) so the icon keeps working.
                </span>
                <button className="btn" style={{ alignSelf: "flex-start", marginTop: 6 }} onClick={() => writeText(st.url!).then(() => toastInfo("Address copied"), toastError)}>
                  <Copy size={14} /> Copy address
                </button>
              </div>
            </div>
          )}
          {st.listening && !st.url && <span className="muted">On, at port {st.port} of this computer's network address.</span>}
          {st.error && <span className="muted">{st.error}</span>}
          <label className="field-row">
            <span>Port</span>
            <input className="input" type="number" min={1024} max={65535} style={{ width: 100 }} value={port} onChange={(e) => setPort(e.target.value)} onBlur={() => st.enabled && Number(port) !== st.port && toggle(true)} />
          </label>
          <PasswordForm status={st} onSaved={setSt} />
          <div className="field-row">
            <span>Remove the password and turn access off</span>
            <button className="btn" onClick={removePassword}>
              Remove
            </button>
          </div>
        </>
      )}
      <div className="setting-card" style={{ alignItems: "flex-start" }}>
        <div className="setting-card-text">
          <strong>Good to know</strong>
          <span className="muted">
            It works while Kokon is open on this computer. Use it on a network you trust, like your home Wi-Fi: the connection is not encrypted, so avoid public or shared networks. To
            reach Kokon from outside, use a private network such as Tailscale, never port forwarding on your router. The first time, your system may ask to allow Kokon on the
            network: allow it on private networks.
          </span>
        </div>
        <div className="row-btns">
          <button className="btn" onClick={() => native.openLink(VIDEOS.remote011.url).catch(toastError)} title="A video of setting it up on a phone, on YouTube (opens in your browser)">
            <CirclePlay size={14} /> Video
          </button>
          <button className="btn" onClick={() => native.openLink(GUIDE_URL).catch(toastError)}>
            <ExternalLink size={14} /> Guide
          </button>
        </div>
      </div>
    </>
  );
}
