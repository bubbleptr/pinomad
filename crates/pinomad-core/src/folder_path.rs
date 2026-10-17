// Host folder paths for the project picker's breadcrumbs and Up navigation,
// from packages/client/src/folder-path.ts. Hosts are POSIX-only, so paths are
// `/`-separated — no platform separator. Slicing is on UTF-16 units like the
// reference.
use crate::text;
use crate::u16str::U16String;

const SLASH: u16 = b'/' as u16;

fn lossy(units: &[u16]) -> String {
    U16String(units.to_vec()).to_string_lossy()
}

#[derive(Clone, Debug)]
#[cfg_attr(feature = "ffi", derive(uniffi::Record))]
pub struct FolderCrumb {
    pub label: String,
    pub path: String,
}

/// `folderCrumbs`: breadcrumb segments — under `home` it starts at "~",
/// otherwise at "/".
pub fn folder_crumbs(path: &str, home: &str) -> Vec<FolderCrumb> {
    let path_u: Vec<u16> = path.encode_utf16().collect();
    let home_u: Vec<u16> = home.encode_utf16().collect();
    // A shared name prefix is not "under home" ("/Users/vx" vs home "/Users/v").
    let under_home = home != "/"
        && (path_u == home_u
            || (path_u.len() > home_u.len() && path_u[..home_u.len()] == home_u[..] && path_u[home_u.len()] == SLASH));
    let root: Vec<u16> = if under_home { home_u } else { vec![SLASH] };
    let mut crumbs = vec![FolderCrumb {
        label: if under_home { "~".to_string() } else { "/".to_string() },
        path: lossy(&root),
    }];
    let mut current: Vec<u16> = if root == [SLASH] { Vec::new() } else { root.clone() };
    for segment in path_u[root.len()..].split(|&u| u == SLASH) {
        if segment.is_empty() {
            continue;
        }
        current.push(SLASH);
        current.extend_from_slice(segment);
        crumbs.push(FolderCrumb {
            label: lossy(segment),
            path: lossy(&current),
        });
    }
    crumbs
}

/// `parentFolder`: the folder one level up, or undefined at "/".
pub fn parent_folder(path: &str) -> Option<String> {
    if path == "/" {
        return None;
    }
    let units: Vec<u16> = path.encode_utf16().collect();
    // No slash at all: lastIndexOf is -1 and JS slice(0, -1) drops the last
    // unit.
    let at = units
        .iter()
        .rposition(|&u| u == SLASH)
        .map(|i| i as i64)
        .unwrap_or(-1);
    Some(if at == 0 {
        "/".to_string()
    } else {
        lossy(&text::slice(&units, 0, Some(at)))
    })
}
