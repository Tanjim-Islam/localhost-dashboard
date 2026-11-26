use super::model::*;
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::Path,
};

#[derive(Default)]
struct Description {
    paths: BTreeSet<String>,
    roles: BTreeSet<String>,
    active: BTreeMap<String, String>,
    owner: String,
}
fn descriptions(s: &Value) -> BTreeMap<String, Description> {
    let eps: BTreeMap<_, _> = list(s, "endpoints")
        .iter()
        .map(|e| (text(e, "id"), e))
        .collect();
    let mut map = BTreeMap::new();
    for i in list(s, "installations") {
        if i["discoveryKind"] == "candidate"
            || matches!(text(i, "origin"), "sdk-bundled" | "application-embedded")
        {
            continue;
        }
        let paths = strings(&i["endpointIds"])
            .filter_map(|id| eps.get(id))
            .map(|e| normal(Path::new(text(e, "path"))))
            .collect();
        let owner = &i["packageIdentity"];
        let owner = if owner.is_null() {
            "Unknown".into()
        } else {
            ["source", "packageId", "scope", "managerRoot"]
                .map(|k| text(owner, k))
                .join(" | ")
        };
        map.insert(
            text(i, "id").to_owned(),
            Description {
                paths,
                owner,
                ..Description::default()
            },
        );
    }
    for c in list(s, "commands") {
        if let Some(d) = map.get_mut(text(c, "installationId")) {
            let pos = strings(&c["endpointIds"])
                .filter_map(|id| eps.get(id)?.get("pathIndex")?.as_u64())
                .min();
            d.roles.insert(format!(
                "{}: {}{}",
                text(c, "name"),
                text(c, "pathRole"),
                pos.map(|n| format!(" (PATH position {})", n + 1))
                    .unwrap_or_default()
            ));
            if let Some(e) = eps.get(text(c, "activeEndpointId")) {
                d.active
                    .insert(text(c, "name").into(), text(e, "path").into());
            }
        }
    }
    map
}
pub(super) fn compare(prev: &Value, next: &Value) -> Value {
    if !prev.is_object() || prev["platform"] != next["platform"] {
        return Value::Null;
    }
    let old = descriptions(prev);
    let new = descriptions(next);
    let mut matched = BTreeSet::<String>::new();
    let mut entries = vec![];
    let mut truncated = false;
    let old_items: BTreeMap<_, _> = list(prev, "installations")
        .iter()
        .map(|i| (text(i, "id"), i))
        .collect();
    let names: BTreeMap<_, _> = list(prev, "products")
        .iter()
        .chain(list(next, "products"))
        .map(|p| (text(p, "id"), text(p, "displayName")))
        .collect();
    let mut by_path: BTreeMap<(&str, &str), Vec<&str>> = BTreeMap::new();
    for (iid, d) in &old {
        if let Some(i) = old_items.get(iid.as_str()) {
            for p in &d.paths {
                by_path
                    .entry((text(i, "productId"), p))
                    .or_default()
                    .push(iid);
            }
        }
    }
    let mut add = |i: &Value, kind: &str, before: String, after: String| {
        if entries.len() == 200 {
            truncated = true;
            return;
        }
        let clean = |s: String| {
            s.chars()
                .take(2048)
                .map(|c| if c.is_control() { ' ' } else { c })
                .collect::<String>()
        };
        let mut v = json!({
            "kind": kind,
            "productId": i["productId"],
            "installationId": i["id"],
            "name": names.get(text(i,"productId")).copied().unwrap_or("CLI"),
        });
        if !before.is_empty() {
            v["before"] = json!(clean(before));
        }
        if !after.is_empty() {
            v["after"] = json!(clean(after));
        }
        entries.push(v)
    };
    let paths = |d: &Description| d.paths.iter().cloned().collect::<Vec<_>>().join("\n");
    let roles = |d: &Description| d.roles.iter().cloned().collect::<Vec<_>>().join(", ");
    let mut active = BTreeMap::new();
    for (iid, d) in &old {
        let prod = text(old_items[iid.as_str()], "productId");
        for (cmd, path) in &d.active {
            active.insert((prod.to_owned(), cmd.clone()), path.clone());
        }
    }
    for i in list(next, "installations") {
        let k = text(i, "id");
        let prod = text(i, "productId");
        let Some(b) = new.get(k) else { continue };
        let previous = if old.contains_key(k) {
            Some(k)
        } else {
            let candidates: BTreeSet<_> = b
                .paths
                .iter()
                .flat_map(|p| {
                    by_path
                        .get(&(prod, p.as_str()))
                        .into_iter()
                        .flatten()
                        .copied()
                })
                .filter(|s| !matched.contains(*s))
                .collect();
            (candidates.len() == 1).then(|| *candidates.first().unwrap())
        };
        if let Some(k) = previous {
            matched.insert(k.into());
            let a = &old[k];
            let prior = old_items[k];
            if i["presence"] != "present" {
                add(i, "uncertain", String::new(), "Could not verify".into());
                continue;
            }
            if i["version"].is_string()
                && prior["version"].is_string()
                && i["version"] != prior["version"]
                && i["versionSource"] != "cached"
            {
                add(
                    i,
                    "version",
                    text(prior, "version").into(),
                    text(i, "version").into(),
                )
            }
            if a.paths != b.paths {
                add(i, "path", paths(a), paths(b))
            }
            if a.roles != b.roles {
                add(i, "precedence", roles(a), roles(b))
            }
            if a.owner != b.owner {
                add(i, "ownership", a.owner.clone(), b.owner.clone())
            }
            if prior["presence"] != i["presence"] || prior["health"] != i["health"] {
                add(
                    i,
                    "availability",
                    format!("{} Â· {}", text(prior, "presence"), text(prior, "health")),
                    format!("{} Â· {}", text(i, "presence"), text(i, "health")),
                );
            }
        } else if i["presence"] == "present" {
            add(i, "added", String::new(), paths(b));
        }
        for (cmd, path) in &b.active {
            if let Some(a) = active.get(&(prod.to_owned(), cmd.clone())) {
                if normal(Path::new(a)) != normal(Path::new(path)) {
                    add(i, "executable", a.clone(), path.clone());
                }
            }
        }
    }
    for (k, d) in &old {
        if matched.contains(k) {
            continue;
        }
        let absent = next["completeness"] == "complete"
            && !list(next, "sourceResults")
                .iter()
                .any(|s| s["status"] == "failed" || !s["errorCode"].is_null())
            && !d.paths.is_empty()
            && d.paths.iter().all(|p| {
                fs::symlink_metadata(p).is_err_and(|e| e.kind() == std::io::ErrorKind::NotFound)
            });
        add(
            old_items[k.as_str()],
            if absent { "removed" } else { "uncertain" },
            paths(d),
            if absent {
                String::new()
            } else {
                "Could not verify".into()
            },
        );
    }
    json!({
        "schemaVersion": 1,
        "comparedAt": next["generatedAt"],
        "baselineAt": prev["generatedAt"],
        "entries": entries,
        "truncated": truncated,
    })
}
