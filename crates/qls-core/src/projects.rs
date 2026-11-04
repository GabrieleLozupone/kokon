//! The project list, shared by every device that uses this Kokon (the desktop app, a phone's
//! browser). Before 0.11 each app kept it in its own browser storage; each one now sends that
//! copy once (`import`) and from then on reads and saves here.
//!
//! A project is the UI's: a title and its versions in order (`items`), each one a gallery image,
//! an imported image or a job still running. Two devices can change the same project at once
//! (an edit made on the phone while the computer has it open), so a save is merged, not
//! overwritten: the saving device sends the versions it knew (`known`), and versions it did not
//! know (added elsewhere since) are kept, while versions it knew and left out were removed by it.
//! Removed projects leave a tombstone, so a device that had not heard yet cannot bring them back.
//! Stored in `<data>/projects.json`.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::error::{AppError, AppResult, ErrorCode};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub key: String,
    /// "gen", "input" or "job".
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gen_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub job_id: Option<String>,
    /// Fields of newer apps, kept as they are (the request of a running job among them).
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Meta {
    pub id: String,
    pub title: String,
    /// The title was typed by the user (otherwise it follows the first prompt).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub named: Option<bool>,
    /// Milliseconds since 1970: the list is sorted by it.
    pub updated_at: f64,
    #[serde(default)]
    pub cover: Option<String>,
    #[serde(default)]
    pub count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub meta: Meta,
    #[serde(default)]
    pub items: Vec<Item>,
    #[serde(default)]
    pub selected: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub loras: Option<Vec<String>>,
    /// Bumped by every change here; a device ignores news of a revision it already has.
    #[serde(default)]
    pub rev: u64,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Default, Serialize, Deserialize)]
struct File {
    #[serde(default)]
    projects: HashMap<String, Project>,
    /// Removed project id → when (ms).
    #[serde(default)]
    deleted: HashMap<String, f64>,
}

/// The gallery and input records of a project's versions, sent in one answer to a browser
/// opening it (one request per version is slow on a phone). A version whose record is gone
/// (deleted from the gallery) is left out.
#[derive(Debug, Default, Serialize)]
pub struct Records {
    pub generations: HashMap<String, crate::store::GenerationRecord>,
    pub inputs: HashMap<String, crate::store::InputRecord>,
}

/// What a change did, for the event the other devices hear.
#[derive(Debug, Clone, PartialEq)]
pub struct Change {
    pub id: String,
    pub rev: u64,
    pub deleted: bool,
}

pub struct ProjectStore {
    path: Option<PathBuf>,
    data: Mutex<File>,
}

fn source(i: &Item) -> Option<String> {
    i.gen_id
        .as_ref()
        .map(|g| format!("gen:{g}"))
        .or_else(|| i.input_id.as_ref().map(|r| format!("input:{r}")))
}

/// The images the project's layers lab made (its `made` list, see src/lib/layerDoc.ts): steps
/// such as one object's crop, never the project's cover.
fn lab_made(p: &Project) -> HashSet<&str> {
    p.extra
        .get("lab")
        .and_then(|l| l.get("made"))
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default()
}

/// The cover (the latest image that is not a lab step) and the number of versions, as the UI
/// computes them.
fn refresh_meta(p: &mut Project) {
    let lab = lab_made(p);
    p.meta.cover = p
        .items
        .iter()
        .rev()
        .filter_map(source)
        .find(|s| !lab.contains(s.as_str()));
    p.meta.count = p.items.iter().filter(|i| i.kind != "job").count() as u32;
}

/// Merges a device's save into the stored copy (see the module comment). Pure, for the tests.
pub fn merge(stored: Option<&Project>, incoming: Project, known: &HashSet<String>) -> Project {
    let Some(stored) = stored else {
        let mut p = incoming;
        p.rev = 1;
        refresh_meta(&mut p);
        return p;
    };
    let mut items = incoming.items.clone();
    // Versions added elsewhere since this device last heard: each goes back after the version
    // it followed there (or at the end).
    let mut anchor: Option<String> = None;
    for it in &stored.items {
        if items.iter().any(|x| x.key == it.key) {
            anchor = Some(it.key.clone());
            continue;
        }
        if known.contains(&it.key) {
            continue;
        }
        let at = anchor
            .as_ref()
            .and_then(|a| items.iter().position(|x| &x.key == a))
            .map(|k| k + 1)
            .unwrap_or(items.len());
        items.insert(at, it.clone());
        anchor = Some(it.key.clone());
    }
    // A running job whose images arrived (here or on another device) is no longer pending.
    let finished: HashSet<String> = items
        .iter()
        .filter(|i| i.kind != "job")
        .filter_map(|i| i.job_id.clone())
        .collect();
    items.retain(|i| i.kind != "job" || !i.job_id.as_ref().is_some_and(|j| finished.contains(j)));

    let mut meta = incoming.meta.clone();
    // A name typed on another device is kept over a title this device made up from a prompt.
    if stored.meta.named == Some(true) && incoming.meta.named != Some(true) {
        meta.title = stored.meta.title.clone();
        meta.named = Some(true);
    }
    meta.updated_at = meta.updated_at.max(stored.meta.updated_at);
    let has = |k: &Option<String>| {
        k.as_ref()
            .is_some_and(|k| items.iter().any(|i| &i.key == k))
    };
    let selected = if has(&incoming.selected) {
        incoming.selected.clone()
    } else if has(&stored.selected) {
        stored.selected.clone()
    } else {
        items.last().map(|i| i.key.clone())
    };
    // Fields a saving device did not send (one that knows nothing of the layers lab) are kept.
    let mut extra = stored.extra.clone();
    extra.extend(incoming.extra);
    let mut p = Project {
        meta,
        items,
        selected,
        loras: incoming.loras.clone(),
        rev: stored.rev + 1,
        extra,
    };
    refresh_meta(&mut p);
    p
}

impl ProjectStore {
    /// Loads `<data_dir>/projects.json` (missing: an empty list).
    pub fn open(data_dir: &Path) -> Self {
        let path = data_dir.join("projects.json");
        let data = match std::fs::read_to_string(&path) {
            Ok(t) => serde_json::from_str(&t).unwrap_or_else(|e| {
                // Unreadable: kept aside instead of being overwritten by the next save.
                tracing::warn!("projects.json is unreadable ({e}); kept as projects.json.bad");
                let _ = std::fs::rename(&path, path.with_extension("json.bad"));
                File::default()
            }),
            Err(_) => File::default(),
        };
        Self {
            path: Some(path),
            data: Mutex::new(data),
        }
    }

    /// Not persisted (tests).
    pub fn in_memory() -> Self {
        Self {
            path: None,
            data: Mutex::new(File::default()),
        }
    }

    fn save(&self, f: &File) -> AppResult<()> {
        let Some(path) = &self.path else {
            return Ok(());
        };
        let text = serde_json::to_vec(f).map_err(AppError::internal)?;
        let tmp = path.with_extension("json.part");
        std::fs::write(&tmp, text).map_err(|e| AppError::io("save the project list", &tmp, e))?;
        std::fs::rename(&tmp, path).map_err(|e| AppError::io("save the project list", path, e))
    }

    /// Every project, most recent first.
    pub fn list(&self) -> Vec<Project> {
        let mut v: Vec<Project> = self
            .data
            .lock()
            .unwrap()
            .projects
            .values()
            .cloned()
            .collect();
        v.sort_by(|a, b| b.meta.updated_at.total_cmp(&a.meta.updated_at));
        v
    }

    pub fn get(&self, id: &str) -> Option<Project> {
        self.data.lock().unwrap().projects.get(id).cloned()
    }

    /// Saves a device's copy of project `id`, merged with what is stored. A removed project
    /// stays removed (NotFound).
    pub fn put(
        &self,
        id: &str,
        mut incoming: Project,
        known: &HashSet<String>,
    ) -> AppResult<(Project, Change)> {
        let mut f = self.data.lock().unwrap();
        if f.deleted.contains_key(id) {
            return Err(AppError::new(
                ErrorCode::NotFound,
                "This project was removed on another device.",
            ));
        }
        incoming.meta.id = id.to_string();
        let merged = merge(f.projects.get(id), incoming, known);
        f.projects.insert(id.to_string(), merged.clone());
        self.save(&f)?;
        let change = Change {
            id: id.to_string(),
            rev: merged.rev,
            deleted: false,
        };
        Ok((merged, change))
    }

    pub fn delete(&self, id: &str, now_ms: f64) -> AppResult<Change> {
        let mut f = self.data.lock().unwrap();
        f.projects.remove(id);
        f.deleted.insert(id.to_string(), now_ms);
        self.save(&f)?;
        Ok(Change {
            id: id.to_string(),
            rev: 0,
            deleted: true,
        })
    }

    /// A device's list from before 0.11 (its browser storage). Projects not here are added,
    /// ones here are merged (nothing of either copy is lost), removed ones stay removed.
    /// Sending the same list again changes nothing.
    pub fn import(&self, list: Vec<Project>) -> AppResult<Vec<Change>> {
        let mut f = self.data.lock().unwrap();
        let mut changes = Vec::new();
        for p in list {
            let id = p.meta.id.clone();
            if id.is_empty() || f.deleted.contains_key(&id) {
                continue;
            }
            let stored = f.projects.get(&id);
            let merged = merge(stored, p, &HashSet::new());
            if stored.is_some_and(|s| merged.items == s.items && merged.meta.title == s.meta.title)
            {
                continue;
            }
            changes.push(Change {
                id: id.clone(),
                rev: merged.rev,
                deleted: false,
            });
            f.projects.insert(id, merged);
        }
        if !changes.is_empty() {
            self.save(&f)?;
        }
        Ok(changes)
    }

    /// Job `job_id` finished: in every project waiting for it, its images replace the pending
    /// version (keys "r-<image id>", the same the apps use, so a device doing it too adds nothing).
    pub fn job_done(
        &self,
        job_id: &str,
        gen_ids: &[String],
        now_ms: f64,
    ) -> AppResult<Vec<Change>> {
        let mut f = self.data.lock().unwrap();
        let mut changes = Vec::new();
        for p in f.projects.values_mut() {
            let Some(k) = p
                .items
                .iter()
                .position(|i| i.kind == "job" && i.job_id.as_deref() == Some(job_id))
            else {
                continue;
            };
            let results: Vec<Item> = gen_ids
                .iter()
                .map(|g| Item {
                    key: format!("r-{g}"),
                    kind: "gen".into(),
                    gen_id: Some(g.clone()),
                    input_id: None,
                    job_id: Some(job_id.to_string()),
                    extra: Map::new(),
                })
                .filter(|r| !p.items.iter().any(|i| i.key == r.key))
                .collect();
            let pending = p.items[k].key.clone();
            let first = results.first().map(|r| r.key.clone());
            p.items.splice(k..k + 1, results);
            if p.selected.as_deref() == Some(pending.as_str()) {
                p.selected = first.or_else(|| p.items.last().map(|i| i.key.clone()));
            }
            p.meta.updated_at = p.meta.updated_at.max(now_ms);
            p.rev += 1;
            refresh_meta(p);
            changes.push(Change {
                id: p.meta.id.clone(),
                rev: p.rev,
                deleted: false,
            });
        }
        if !changes.is_empty() {
            self.save(&f)?;
        }
        Ok(changes)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn img(key: &str) -> Item {
        Item {
            key: key.into(),
            kind: "gen".into(),
            gen_id: Some(format!("g{key}")),
            input_id: None,
            job_id: None,
            extra: Map::new(),
        }
    }

    fn job(key: &str, job: &str) -> Item {
        Item {
            key: key.into(),
            kind: "job".into(),
            gen_id: None,
            input_id: None,
            job_id: Some(job.into()),
            extra: Map::new(),
        }
    }

    fn project(id: &str, items: Vec<Item>) -> Project {
        Project {
            meta: Meta {
                id: id.into(),
                title: "A prompt".into(),
                named: None,
                updated_at: 1.0,
                cover: None,
                count: 0,
            },
            selected: items.last().map(|i| i.key.clone()),
            items,
            loras: None,
            rev: 0,
            extra: Map::new(),
        }
    }

    fn keys(p: &Project) -> Vec<&str> {
        p.items.iter().map(|i| i.key.as_str()).collect()
    }

    fn known(k: &[&str]) -> HashSet<String> {
        k.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn the_cover_is_never_a_layers_lab_step() {
        let mut p = project("p", vec![img("a"), img("b")]);
        p.extra.insert("lab".into(), serde_json::json!({ "v": 2, "docs": [], "made": ["gen:gb"] }));
        let (p, _) = ProjectStore::in_memory().put("p", p, &known(&[])).unwrap();
        assert_eq!(p.meta.cover.as_deref(), Some("gen:ga"));
        assert_eq!(p.meta.count, 2);
    }

    #[test]
    fn a_new_project_is_stored_with_its_cover_and_count() {
        let s = ProjectStore::in_memory();
        let (p, c) = s
            .put(
                "p",
                project("p", vec![img("a"), job("b", "j1")]),
                &known(&[]),
            )
            .unwrap();
        assert_eq!(
            c,
            Change {
                id: "p".into(),
                rev: 1,
                deleted: false
            }
        );
        assert_eq!(p.meta.cover.as_deref(), Some("gen:ga"));
        assert_eq!(p.meta.count, 1);
    }

    #[test]
    fn versions_added_on_two_devices_are_both_kept() {
        let s = ProjectStore::in_memory();
        s.put("p", project("p", vec![img("a")]), &known(&[]))
            .unwrap();
        // The phone adds b, the computer (which only knew a) adds c.
        s.put("p", project("p", vec![img("a"), img("b")]), &known(&["a"]))
            .unwrap();
        let (p, _) = s
            .put("p", project("p", vec![img("a"), img("c")]), &known(&["a"]))
            .unwrap();
        assert_eq!(keys(&p), ["a", "b", "c"]);
        assert_eq!(p.rev, 3);
    }

    #[test]
    fn a_version_removed_by_a_device_that_knew_it_stays_removed() {
        let s = ProjectStore::in_memory();
        s.put("p", project("p", vec![img("a"), img("b")]), &known(&[]))
            .unwrap();
        let (p, _) = s
            .put("p", project("p", vec![img("a")]), &known(&["a", "b"]))
            .unwrap();
        assert_eq!(keys(&p), ["a"]);
    }

    #[test]
    fn a_version_from_elsewhere_goes_back_after_the_one_it_followed() {
        let stored = project("p", vec![img("a"), img("x"), img("b")]);
        let p = merge(
            Some(&stored),
            project("p", vec![img("a"), img("b"), img("c")]),
            &known(&["a", "b"]),
        );
        assert_eq!(keys(&p), ["a", "x", "b", "c"]);
    }

    #[test]
    fn a_finished_job_replaces_its_pending_version_once() {
        let s = ProjectStore::in_memory();
        s.put(
            "p",
            project("p", vec![img("a"), job("k", "j1")]),
            &known(&[]),
        )
        .unwrap();
        let ch = s.job_done("j1", &["g1".into(), "g2".into()], 5.0).unwrap();
        assert_eq!(ch.len(), 1);
        let p = s.get("p").unwrap();
        assert_eq!(keys(&p), ["a", "r-g1", "r-g2"]);
        assert_eq!(p.selected.as_deref(), Some("r-g1"));
        assert_eq!(p.meta.count, 3);
        // The app that made it does the same with the same keys: no copies, no pending left.
        let (p, _) = s
            .put(
                "p",
                project(
                    "p",
                    vec![
                        img("a"),
                        job("k", "j1"),
                        Item {
                            key: "r-g1".into(),
                            job_id: Some("j1".into()),
                            ..img("r-g1")
                        },
                    ],
                ),
                &known(&["a", "k"]),
            )
            .unwrap();
        assert_eq!(keys(&p), ["a", "r-g1", "r-g2"]);
        assert!(s.job_done("j1", &["g1".into()], 6.0).unwrap().is_empty());
    }

    #[test]
    fn a_name_typed_elsewhere_beats_a_title_from_a_prompt() {
        let mut stored = project("p", vec![img("a")]);
        stored.meta.title = "Holiday".into();
        stored.meta.named = Some(true);
        let p = merge(Some(&stored), project("p", vec![img("a")]), &known(&["a"]));
        assert_eq!(p.meta.title, "Holiday");
        let mut renamed = project("p", vec![img("a")]);
        renamed.meta.title = "Trip".into();
        renamed.meta.named = Some(true);
        assert_eq!(
            merge(Some(&stored), renamed, &known(&["a"])).meta.title,
            "Trip"
        );
    }

    #[test]
    fn removed_projects_stay_removed() {
        let s = ProjectStore::in_memory();
        s.put("p", project("p", vec![img("a")]), &known(&[]))
            .unwrap();
        s.delete("p", 2.0).unwrap();
        assert!(
            s.put("p", project("p", vec![img("a")]), &known(&[]))
                .is_err()
        );
        assert!(
            s.import(vec![project("p", vec![img("a")])])
                .unwrap()
                .is_empty()
        );
        assert!(s.list().is_empty());
    }

    #[test]
    fn importing_merges_lists_and_twice_changes_nothing() {
        let s = ProjectStore::in_memory();
        s.put("p", project("p", vec![img("a")]), &known(&[]))
            .unwrap();
        let phone = vec![
            project("p", vec![img("a"), img("b")]),
            project("q", vec![img("c")]),
        ];
        assert_eq!(s.import(phone.clone()).unwrap().len(), 2);
        assert_eq!(keys(&s.get("p").unwrap()), ["a", "b"]);
        assert!(s.import(phone).unwrap().is_empty());
        assert_eq!(s.list().len(), 2);
    }

    #[test]
    fn the_list_survives_a_restart_and_keeps_unknown_fields() {
        let dir = tempfile::tempdir().unwrap();
        let s = ProjectStore::open(dir.path());
        let mut p = project("p", vec![img("a")]);
        p.items[0].extra.insert("future".into(), Value::from(1));
        s.put("p", p, &known(&[])).unwrap();
        let again = ProjectStore::open(dir.path());
        assert_eq!(
            again.get("p").unwrap().items[0].extra.get("future"),
            Some(&Value::from(1))
        );
    }

    #[test]
    fn a_save_without_a_field_keeps_the_stored_one() {
        // The layers lab travels with the project; a device that does not send it keeps it.
        let mut stored = project("p", vec![img("a")]);
        stored.extra.insert("lab".into(), Value::from("doc"));
        let stored = merge(None, stored, &known(&[]));
        let m = merge(Some(&stored), project("p", vec![img("a"), img("b")]), &known(&["a"]));
        assert_eq!(m.extra.get("lab"), Some(&Value::from("doc")));
        let mut cleared = project("p", vec![img("a")]);
        cleared.extra.insert("lab".into(), Value::Null);
        assert_eq!(merge(Some(&m), cleared, &known(&["a", "b"])).extra.get("lab"), Some(&Value::Null));
    }

    #[test]
    fn the_stored_format_reads_what_the_app_saved_before() {
        // A project as 0.10's UI kept it in browser storage.
        let v: Project = serde_json::from_str(
            r#"{"meta":{"id":"p","title":"Cat","updatedAt":1700000000000,"cover":"gen:g1","count":1},
                "items":[{"key":"k1","kind":"gen","genId":"g1","jobId":"j"},{"key":"k2","kind":"job","jobId":"j2","request":{"prompt":"x"}}],
                "selected":"k1","loras":["l"]}"#,
        )
        .unwrap();
        assert_eq!(
            v.items[1]
                .extra
                .get("request")
                .and_then(|r| r.get("prompt")),
            Some(&Value::from("x"))
        );
        let back = serde_json::to_value(&v).unwrap();
        assert_eq!(back["items"][0]["genId"], "g1");
        assert_eq!(back["meta"]["updatedAt"], 1700000000000.0);
    }
}
