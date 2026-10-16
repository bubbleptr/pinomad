// The project → conversation model from packages/protocol/src/organization.ts,
// ported onto the raw Json view values rather than typed structs — the wire
// is the same, and a non-conforming value degrades exactly where the
// reference's untyped accesses would trip.

use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};
use std::rc::Rc;

use crate::json::{Json, JsonObject};
use crate::u16str::U16String;

fn set(obj: &mut JsonObject, key: &str, value: Json) {
    obj.set(U16String::from_str(key), value);
}

fn num_key(value: Option<&Json>) -> Option<u64> {
    match value {
        Some(Json::Number(v)) if v.fract() == 0.0 && *v >= 0.0 && *v <= u64::MAX as f64 => Some(*v as u64),
        _ => None,
    }
}

fn number(value: Option<&Json>, or: f64) -> f64 {
    value.and_then(Json::as_number).unwrap_or(or)
}

/// `organize(index, summaries)`: index entries + summaries →
/// `{chats, projects, archived}` with `{summary, children}` nodes. Missing
/// collections behave like the JS defaults ({projects:[], conversations:[]}).
pub fn organize(index: &Json, summaries: &[Json]) -> Result<Json, String> {
    let projects = index
        .get("projects")
        .and_then(Json::as_array)
        .ok_or_else(|| "index.projects is not an array".to_string())?;
    let entries = index
        .get("conversations")
        .and_then(Json::as_array)
        .ok_or_else(|| "index.conversations is not an array".to_string())?;

    let summary_by_id: HashMap<u64, &Json> = summaries
        .iter()
        .filter_map(|summary| num_key(summary.get("id")).map(|id| (id, summary)))
        .collect();
    let mut nodes: HashMap<u64, Vec<u64>> = HashMap::new(); // id -> child ids
    let mut summary_of: HashMap<u64, &Json> = HashMap::new();
    let mut top_level: Vec<&Json> = Vec::new();

    for entry in entries.iter() {
        let home = entry.get("home");
        let kind = home.and_then(|h| h.get("kind")).and_then(Json::as_str).map(|s| s.to_string_lossy());
        if kind.as_deref() == Some("project") {
            let path = home.and_then(|h| h.get("path")).and_then(Json::as_str).map(|s| s.to_string_lossy());
            let exists = projects.iter().any(|project| {
                project.get("path").and_then(Json::as_str).map(|s| s.to_string_lossy()) == path
            });
            if !exists {
                continue;
            }
        }
        let id = match num_key(entry.get("id")) {
            Some(id) if summary_by_id.contains_key(&id) => id,
            _ => continue,
        };
        top_level.push(entry);
        nodes.entry(id).or_default();
        summary_of.insert(id, summary_by_id[&id]);
    }
    let top_ids: HashSet<u64> = top_level
        .iter()
        .filter_map(|entry| num_key(entry.get("id")))
        .collect();

    // A nested summary joins once its ancestor chain reaches a top-level entry.
    for summary in summaries.iter() {
        if num_key(summary.get("id")).is_none() {
            continue;
        }
        let mut chain: Vec<&Json> = vec![summary];
        while !top_ids.contains(&num_key(chain.last().unwrap().get("id")).unwrap_or(u64::MAX)) {
            let parent_id = num_key(chain.last().unwrap().get("parent"));
            let parent = parent_id.and_then(|pid| summary_by_id.get(&pid).copied());
            let Some(parent) = parent else { break };
            if chain.iter().any(|member| std::ptr::eq(*member, parent)) {
                break;
            }
            chain.push(parent);
        }
        let anchor = match num_key(chain.last().unwrap().get("id")) {
            Some(anchor) if top_ids.contains(&anchor) => anchor,
            _ => continue,
        };
        // Oldest ancestor first: each node attaches under its immediate parent.
        for member in chain.iter().rev() {
            let member_id = match num_key(member.get("id")) {
                Some(id) => id,
                None => continue,
            };
            nodes.entry(member_id).or_default();
            summary_of.insert(member_id, member);
        }
        // Attach: parent is the element AFTER member in the reversed walk —
        // chain is [descendant..ancestor]; reversed is [ancestor..descendant].
        let reversed: Vec<&&Json> = chain.iter().rev().collect();
        for pair in reversed.windows(2) {
            let parent_id = num_key(pair[0].get("id"));
            let child_id = num_key(pair[1].get("id"));
            if let (Some(parent_id), Some(child_id)) = (parent_id, child_id) {
                let children = nodes.entry(parent_id).or_default();
                if !children.contains(&child_id) {
                    children.push(child_id);
                }
            }
        }
        let _ = anchor;
    }

    let node_list = |entry: &Json, nodes: &HashMap<u64, Vec<u64>>, summary_of: &HashMap<u64, &Json>| -> Json {
        let id = num_key(entry.get("id")).unwrap_or(0);
        build_node(id, nodes, summary_of)
    };
    let sort_entries = |list: &mut Vec<&Json>| {
        list.sort_by(|a, b| {
            number(b.get("createdAt"), f64::NAN)
                .partial_cmp(&number(a.get("createdAt"), f64::NAN))
                .unwrap_or(Ordering::Equal)
        });
    };
    let mut sorted: Vec<&Json> = top_level.clone();
    sort_entries(&mut sorted);
    let live: Vec<&&Json> = sorted
        .iter()
        .filter(|entry| entry.get("archived") != Some(&Json::Bool(true)))
        .collect();

    let chats = Json::array(
        live.iter()
            .filter(|entry| {
                entry
                    .get("home")
                    .and_then(|h| h.get("kind"))
                    .and_then(Json::as_str)
                    .map(|s| s.to_string_lossy() == "chat")
                    .unwrap_or(false)
            })
            .map(|entry| node_list(entry, &nodes, &summary_of))
            .collect(),
    );

    let mut sorted_projects: Vec<&Json> = projects.iter().collect();
    sorted_projects.sort_by(|a, b| {
        number(b.get("addedAt"), f64::NAN)
            .partial_cmp(&number(a.get("addedAt"), f64::NAN))
            .unwrap_or(Ordering::Equal)
    });
    let projects_json = Json::array(
        sorted_projects
            .iter()
            .map(|project| {
                let path = project.get("path").and_then(Json::as_str).map(|s| s.to_string_lossy());
                let conversations = Json::array(
                    live.iter()
                        .filter(|entry| {
                            let home = entry.get("home");
                            home.and_then(|h| h.get("kind"))
                                .and_then(Json::as_str)
                                .map(|s| s.to_string_lossy() == "project")
                                .unwrap_or(false)
                                && home
                                    .and_then(|h| h.get("path"))
                                    .and_then(Json::as_str)
                                    .map(|s| s.to_string_lossy())
                                    == path.clone()
                        })
                        .map(|entry| node_list(entry, &nodes, &summary_of))
                        .collect(),
                );
                let mut object = JsonObject::new();
                set(&mut object, "project", (*project).clone());
                set(&mut object, "conversations", conversations);
                Json::Object(Rc::new(object))
            })
            .collect(),
    );

    let archived = Json::array(
        sorted
            .iter()
            .filter(|entry| entry.get("archived") == Some(&Json::Bool(true)))
            .map(|entry| {
                let mut object = JsonObject::new();
                set(&mut object, "node", node_list(entry, &nodes, &summary_of));
                let home = entry.get("home");
                if home
                    .and_then(|h| h.get("kind"))
                    .and_then(Json::as_str)
                    .map(|s| s.to_string_lossy() == "project")
                    .unwrap_or(false)
                {
                    let path = home.and_then(|h| h.get("path")).and_then(Json::as_str).map(|s| s.to_string_lossy());
                    if let Some(project) = projects.iter().find(|project| {
                        project.get("path").and_then(Json::as_str).map(|s| s.to_string_lossy()) == path
                    }) {
                        set(&mut object, "project", project.clone());
                    }
                }
                Json::Object(Rc::new(object))
            })
            .collect(),
    );

    let mut out = JsonObject::new();
    set(&mut out, "chats", chats);
    set(&mut out, "projects", projects_json);
    set(&mut out, "archived", archived);
    Ok(Json::Object(Rc::new(out)))
}

fn build_node(id: u64, nodes: &HashMap<u64, Vec<u64>>, summary_of: &HashMap<u64, &Json>) -> Json {
    let mut children: Vec<u64> = nodes.get(&id).cloned().unwrap_or_default();
    // `byIdAscending`: children sort by summary.id ascending.
    children.sort_by(|a, b| (*a).cmp(b));
    let mut object = JsonObject::new();
    set(&mut object, "summary", summary_of.get(&id).copied().cloned().unwrap_or(Json::Null));
    set(
        &mut object,
        "children",
        Json::array(children.into_iter().map(|child| build_node(child, nodes, summary_of)).collect()),
    );
    Json::Object(Rc::new(object))
}

/// `homeOf`: the conversation's home — its own entry's, else the nearest
/// index-listed ancestor's.
pub fn home_of(index: &Json, summaries: &[Json], id: u64) -> Option<Json> {
    let entries = index.get("conversations").and_then(Json::as_array)?;
    if let Some(entry) = entries.iter().find(|entry| num_key(entry.get("id")) == Some(id)) {
        return entry.get("home").cloned();
    }
    let summary_by_id: HashMap<u64, &Json> = summaries
        .iter()
        .filter_map(|summary| num_key(summary.get("id")).map(|sid| (sid, summary)))
        .collect();
    let mut seen = HashSet::new();
    let mut current = summary_by_id.get(&id).copied();
    while let Some(summary) = current {
        let sid = match num_key(summary.get("id")) {
            Some(sid) if seen.insert(sid) => sid,
            _ => break,
        };
        if let Some(entry) = entries.iter().find(|entry| num_key(entry.get("id")) == Some(sid)) {
            return entry.get("home").cloned();
        }
        current = num_key(summary.get("parent")).and_then(|pid| summary_by_id.get(&pid).copied());
    }
    None
}

/// `checkoutOf`: the conversation's own checkout, else the nearest
/// ancestor's.
pub fn checkout_of(index: &Json, summaries: &[Json], id: u64) -> Option<Json> {
    let checkouts = index.get("checkouts").and_then(Json::as_array);
    if let Some(record) = checkouts.and_then(|list| {
        list.iter().find(|checkout| num_key(checkout.get("conversationId")) == Some(id))
    }) {
        return Some(record.clone());
    }
    let summary_by_id: HashMap<u64, &Json> = summaries
        .iter()
        .filter_map(|summary| num_key(summary.get("id")).map(|sid| (sid, summary)))
        .collect();
    let mut seen = HashSet::new();
    let mut current = summary_by_id.get(&id).copied();
    while let Some(summary) = current {
        let sid = match num_key(summary.get("id")) {
            Some(sid) if seen.insert(sid) => sid,
            _ => break,
        };
        if let Some(record) = checkouts.and_then(|list| {
            list.iter().find(|checkout| num_key(checkout.get("conversationId")) == Some(sid))
        }) {
            return Some(record.clone());
        }
        current = num_key(summary.get("parent")).and_then(|pid| summary_by_id.get(&pid).copied());
    }
    None
}
