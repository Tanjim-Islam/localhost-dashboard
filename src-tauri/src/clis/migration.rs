use super::{
    inventory::{capability, products},
    model::*,
};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::Path,
};

// Old versions assigned different installation IDs to the .cmd and .ps1 forms
// of one launcher. Normalize that structure using saved evidence only.
pub(super) fn legacy(v: &Value) -> Value {
    let mut snapshot = v.clone();
    snapshot["schemaVersion"] = json!(2);
    let eps: BTreeMap<_, _> = list(v, "endpoints")
        .iter()
        .filter(|e| e["id"].is_string() && e["path"].is_string())
        .map(|e| (text(e, "id"), e))
        .collect();
    let mut groups = BTreeMap::<String, Value>::new();
    for i in list(v, "installations") {
        let prod = text(i, "productId");
        if prod.is_empty() {
            continue;
        }
        let endpoints: Vec<_> = strings(&i["endpointIds"])
            .filter_map(|k| eps.get(k).copied())
            .collect();
        let Some(first) = endpoints.first() else {
            continue;
        };
        let ident = &i["packageIdentity"];
        let path = Path::new(
            first["canonicalPath"]
                .as_str()
                .unwrap_or(text(first, "path")),
        );
        let group = if v["platform"] == "win32" {
            normal(path.parent().unwrap_or(path))
        } else {
            normal(path)
        };
        let standalone = if ident.is_object() {
            String::new()
        } else {
            format!("{prod}|{group}")
        };
        let key = id(
            "cli",
            json!({"platform":v["platform"],"productId":prod,"source":ident["source"].as_str().unwrap_or("standalone"),"packageId":text(ident,"packageId").to_lowercase(),"scope":ident["scope"].as_str().unwrap_or("unknown"),"managerRoot":normal(Path::new(text(ident,"managerRoot"))),"installationRoot":normal(Path::new(text(ident,"installRoot"))),"canonicalPath":standalone}),
        );
        let row = groups.entry(key.clone()).or_insert_with(|| {
            let mut row = i.clone();
            row["id"] = json!(key);
            row["endpointIds"] = json!([]);
            row["commandIds"] = json!([]);
            row["discoveryKind"] = json!(if definitions().any(|d| d.id == prod) {
                "catalogue"
            } else if ident.is_object()
                && !matches!(text(ident, "source"), "registry" | "winget" | "chocolatey")
            {
                "package-command"
            } else if i["includedByUser"] == true {
                "user"
            } else {
                "candidate"
            });
            row
        });
        if let Some(t) = i["firstSeenAt"].as_u64() {
            row["firstSeenAt"] = json!(row["firstSeenAt"].as_u64().unwrap_or(t).min(t));
        }
        for e in endpoints {
            if !strings(&row["endpointIds"]).any(|k| k == text(e, "id")) {
                row["endpointIds"]
                    .as_array_mut()
                    .unwrap()
                    .push(e["id"].clone());
            }
        }
    }
    let mut commands = vec![];
    let mut retained = BTreeSet::new();
    let mut active = BTreeMap::<String, (u64, u64, String)>::new();
    let runnable = |e: &Value| {
        e["executable"] != false
            && e["targetExists"] != false
            && (v["platform"] != "win32" || Path::new(text(e, "path")).extension().is_some())
    };
    for i in groups
        .values()
        .filter(|i| !matches!(text(i, "origin"), "application-embedded" | "sdk-bundled"))
    {
        for ep in strings(&i["endpointIds"])
            .filter_map(|k| eps.get(k))
            .filter(|e| runnable(e))
        {
            if let Some(index) = ep["pathIndex"].as_u64() {
                let rank = (
                    index,
                    ep["pathextIndex"].as_u64().unwrap_or(99),
                    text(ep, "id").to_owned(),
                );
                active
                    .entry(text(ep, "commandName").into())
                    .and_modify(|old| *old = old.clone().min(rank.clone()))
                    .or_insert(rank);
            }
        }
    }
    groups.retain(|_,i|{
        let mut names=BTreeMap::<String,Vec<&Value>>::new();let local:Vec<_>=strings(&i["endpointIds"]).filter_map(|k|eps.get(k).copied()).collect();
        if v["platform"]=="win32"&&local.iter().all(|e|Path::new(text(e,"path")).extension().is_none()){return false}
        for ep in local{retained.insert(text(ep,"id").to_owned());names.entry(text(ep,"commandName").into()).or_default().push(ep);}
        let provided:Vec<_>=names.keys().cloned().collect();for(name,eps)in names{let cid=id("command",json!({"installationId":i["id"],"name":name}));let chosen=eps.iter().find(|ep|active.get(&name).is_some_and(|r|ep["id"]==r.2));let has_path=eps.iter().any(|ep|runnable(ep)&&ep["pathIndex"].is_number());
            let mut c=json!({"id":cid,"productId":i["productId"],"installationId":i["id"],"name":name,"endpointIds":eps.iter().map(|e|&e["id"]).collect::<Vec<_>>(),"pathRole":if chosen.is_some(){"active"}else if has_path{"shadowed"}else{"not-on-path"}});
            if let Some(ep)=chosen{c["activeEndpointId"]=ep["id"].clone();}commands.push(c);i["commandIds"].as_array_mut().unwrap().push(json!(cid));
        }i["uninstallCapability"]=capability(&i["packageIdentity"],text(i,"productId"),text(i,"origin"),&provided);
        true
    });
    snapshot["installations"] = json!(groups.into_values().collect::<Vec<_>>());
    snapshot["commands"] = json!(commands);
    snapshot["endpoints"] = json!(eps
        .into_iter()
        .filter(|(k, _)| retained.contains(*k))
        .map(|(_, v)| v)
        .collect::<Vec<_>>());
    products(&mut snapshot);
    snapshot
}
