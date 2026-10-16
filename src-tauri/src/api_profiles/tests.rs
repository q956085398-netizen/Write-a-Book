use super::*;
use std::{net::TcpListener, sync::mpsc, thread};

fn draft(endpoint: &str) -> ProfileDraft {
    ProfileDraft {
        id: None,
        name: "受控测试".into(),
        endpoint: endpoint.into(),
        model: "fixture-text".into(),
        is_default: false,
        key: Some("fake-key-never-real".into()),
    }
}
fn endpoint(
    status: &str,
    headers: &str,
    body: &str,
) -> (String, mpsc::Receiver<String>, thread::JoinHandle<()>) {
    let server = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!(
        "http://{}/v1/chat/completions",
        server.local_addr().unwrap()
    );
    let (tx, rx) = mpsc::channel();
    let response = format!("HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n{headers}\r\n{body}", body.len());
    let handle = thread::spawn(move || {
        let (mut socket, _) = server.accept().unwrap();
        socket
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        let mut bytes = Vec::new();
        let mut block = [0u8; 2048];
        loop {
            let length = socket.read(&mut block).unwrap();
            if length == 0 {
                break;
            }
            bytes.extend_from_slice(&block[..length]);
            if let Some(header_end) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                let header = String::from_utf8_lossy(&bytes[..header_end]);
                let content_length = header
                    .lines()
                    .find_map(|line| {
                        line.to_ascii_lowercase()
                            .strip_prefix("content-length:")
                            .map(|v| v.trim().parse::<usize>().unwrap())
                    })
                    .unwrap_or(0);
                if bytes.len() >= header_end + 4 + content_length {
                    break;
                }
            }
        }
        tx.send(String::from_utf8(bytes).unwrap()).unwrap();
        socket.write_all(response.as_bytes()).unwrap();
    });
    (url, rx, handle)
}
fn successful_body() -> &'static str {
    r#"{"choices":[{"message":{"role":"assistant","content":"OK"}}]}"#
}

#[test]
fn validation_rejects_secret_in_url_and_plain_remote_http() {
    for url in [
        "http://example.com/v1",
        "https://u:p@example.com/v1",
        "https://example.com/v1?key=x",
        "https://example.com/v1#x",
        "file:///tmp/key",
    ] {
        assert!(validate(&draft(url)).is_err());
    }
    for url in [
        "https://example.com/v1/chat/completions",
        "http://127.0.0.1:8000/v1/chat/completions",
        "http://[::1]:8000/v1/chat/completions",
    ] {
        assert!(validate(&draft(url)).is_ok());
    }
}
#[test]
fn one_fixed_small_post_contains_no_project_or_profile_name() {
    let (url, received, server) = endpoint("200 OK", "", successful_body());
    let temp = tempfile::tempdir().unwrap();
    let profiles = ApiProfiles::open(temp.path()).unwrap();
    let result = profiles
        .prepare_test(&draft(&url))
        .unwrap()
        .execute()
        .unwrap();
    assert!(result.message.contains("成功"));
    let request = received.recv().unwrap();
    server.join().unwrap();
    let (headers, body) = request.split_once("\r\n\r\n").unwrap();
    assert!(headers.starts_with("POST /v1/chat/completions HTTP/1.1"));
    assert!(headers
        .to_lowercase()
        .contains("authorization: bearer fake-key-never-real"));
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(body).unwrap(),
        serde_json::json!({ "model":"fixture-text", "messages":[{"role":"user","content":"Reply with OK."}], "max_completion_tokens":16, "stream":false, "store":false })
    );
    assert!(!request.contains("受控测试"));
    assert!(profiles.list().unwrap().is_empty(), "testing must not save");
}
#[test]
fn error_bodies_are_not_reflected_and_redirect_is_not_followed() {
    for (status, headers, body, expected) in [
        ("401 Unauthorized", "", "fake-key-never-real", "401"),
        ("429 Too Many Requests", "", "fake-key-never-real", "429"),
        (
            "302 Found",
            "Location: http://127.0.0.1:1/stolen\r\n",
            "",
            "跳转",
        ),
        ("200 OK", "", "not json fake-key-never-real", "JSON"),
        ("200 OK", "", r#"{"choices":[]}"#, "文本回答"),
    ] {
        let (url, received, server) = endpoint(status, headers, body);
        let temp = tempfile::tempdir().unwrap();
        let profiles = ApiProfiles::open(temp.path()).unwrap();
        let error = profiles
            .prepare_test(&draft(&url))
            .unwrap()
            .execute()
            .err()
            .unwrap();
        assert!(error.contains(expected), "{error}");
        assert!(!error.contains("fake-key"));
        received.recv().unwrap();
        server.join().unwrap();
    }
}
#[test]
fn successful_response_must_stay_within_size_limit() {
    let (url, received, server) = endpoint("200 OK", "", &"x".repeat(65_537));
    let temp = tempfile::tempdir().unwrap();
    let profiles = ApiProfiles::open(temp.path()).unwrap();
    assert!(profiles
        .prepare_test(&draft(&url))
        .unwrap()
        .execute()
        .err()
        .unwrap()
        .contains("大小限制"));
    received.recv().unwrap();
    server.join().unwrap();
}
#[test]
fn slow_endpoint_is_bounded() {
    let server = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!(
        "http://{}/v1/chat/completions",
        server.local_addr().unwrap()
    );
    let worker = thread::spawn(move || {
        let (_socket, _) = server.accept().unwrap();
        thread::sleep(Duration::from_millis(250));
    });
    let temp = tempfile::tempdir().unwrap();
    let profiles = ApiProfiles::open(temp.path()).unwrap();
    let error = profiles
        .prepare_test(&draft(&url))
        .unwrap()
        .execute_with_timeout(Duration::from_millis(60))
        .err()
        .unwrap();
    assert!(error.contains("超时"));
    worker.join().unwrap();
}
#[cfg(windows)]
#[test]
fn dpapi_persists_multiple_profiles_defaults_and_excludes_secrets_from_backup() {
    let temp = tempfile::tempdir().unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let url = format!(
        "http://{}/v1/chat/completions",
        listener.local_addr().unwrap()
    );
    let mut profiles = ApiProfiles::open(temp.path()).unwrap();
    let first = profiles.save(&draft(&url)).unwrap()[0].clone();
    assert!(first.profile.is_default && first.has_key);
    assert!(listener.accept().is_err(), "saving must make zero requests");
    let mut second = draft(&url);
    second.name = "第二套".into();
    second.key = Some("fake-second-key".into());
    second.is_default = true;
    profiles.save(&second).unwrap();
    drop(profiles);
    let profiles = ApiProfiles::open(temp.path()).unwrap();
    let views = profiles.list().unwrap();
    assert_eq!(views.len(), 2);
    assert!(!views[0].profile.is_default && views[1].profile.is_default);
    let mut saved = draft(&url);
    saved.id = Some(first.profile.id);
    saved.key = None;
    assert_eq!(
        profiles.prepare_test(&saved).unwrap().key.as_str(),
        "fake-key-never-real"
    );
    let backup = serde_json::to_string(&profiles.export_public().unwrap()).unwrap();
    assert!(!backup.contains("key") && !backup.contains("fake-"));
    let listing = serde_json::to_string(&views).unwrap();
    assert!(!listing.contains("fake-key") && !listing.contains("keyRef"));
    for entry in fs::read_dir(temp.path().join("api-secrets")).unwrap() {
        let bytes = fs::read(entry.unwrap().path()).unwrap();
        assert!(!bytes.windows(9).any(|w| w == b"fake-key-"));
    }
    let database = fs::read(temp.path().join("api-profiles.sqlite3")).unwrap();
    assert!(!database.windows(9).any(|w| w == b"fake-key-"));
}
#[cfg(windows)]
#[test]
fn failed_save_preserves_old_key_and_endpoint_changes_require_reentry() {
    let temp = tempfile::tempdir().unwrap();
    let mut profiles = ApiProfiles::open(temp.path()).unwrap();
    let first = profiles
        .save(&draft("https://example.com/v1/chat/completions"))
        .unwrap()[0]
        .clone();
    let mut second = draft("https://example.com/v1/chat/completions");
    second.name = "second".into();
    profiles.save(&second).unwrap();
    let mut change = draft("https://example.com/v1/chat/completions");
    change.id = Some(first.profile.id.clone());
    change.name = "second".into();
    change.key = Some("fake-replacement-key".into());
    assert!(profiles.save(&change).is_err());
    change.key = None;
    assert_eq!(
        profiles.prepare_test(&change).unwrap().key.as_str(),
        "fake-key-never-real"
    );
    change.endpoint = "https://new.example.com/v1/chat/completions".into();
    assert!(profiles.save(&change).is_err());
    assert!(profiles.prepare_test(&change).is_err());
    change.endpoint = "https://example.com/v1/chat/completions".into();
    change.key = Some("fake-replacement-key".into());
    fs::rename(&profiles.secrets, temp.path().join("protected-backup")).unwrap();
    fs::write(&profiles.secrets, b"block-directory").unwrap();
    assert!(profiles.save(&change).is_err());
    fs::remove_file(&profiles.secrets).unwrap();
    fs::rename(temp.path().join("protected-backup"), &profiles.secrets).unwrap();
    change.key = None;
    assert_eq!(
        profiles.prepare_test(&change).unwrap().key.as_str(),
        "fake-key-never-real"
    );
    let (_, reference) = profiles.existing(&first.profile.id).unwrap();
    fs::write(profiles.secret_path(&reference).unwrap(), b"corrupt").unwrap();
    assert!(profiles.prepare_test(&change).is_err());
}

#[test]
fn optional_api_storage_failure_does_not_prevent_state_creation_and_can_retry() {
    let temp = tempfile::tempdir().unwrap();
    let config = temp.path().join("lazy-config");
    let state = ApiProfileState::new(config.clone());
    assert!(!config.exists());
    fs::write(&config, b"block directory").unwrap();
    assert!(state.access(|profiles| profiles.list()).is_err());
    fs::remove_file(&config).unwrap();
    assert!(state.access(|profiles| profiles.list()).unwrap().is_empty());
}
#[cfg(windows)]
#[test]
fn dpapi_rejects_truncated_and_tampered_ciphertext() {
    let encrypted = protection::protect(b"fake-secret-for-protection-test").unwrap();
    assert_eq!(
        &*protection::unprotect(&encrypted).unwrap(),
        b"fake-secret-for-protection-test"
    );
    assert!(protection::unprotect(&encrypted[..encrypted.len() / 2]).is_err());
    let mut tampered = encrypted.to_vec();
    let last = tampered.len() - 1;
    tampered[last] ^= 0xff;
    assert!(protection::unprotect(&tampered).is_err());
}

#[test]
fn trickling_response_has_a_total_deadline() {
    let server = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!(
        "http://{}/v1/chat/completions",
        server.local_addr().unwrap()
    );
    let worker = thread::spawn(move || {
        let (mut socket, _) = server.accept().unwrap();
        socket
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let mut buf = [0; 4096];
        let _ = socket.read(&mut buf);
        if socket
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\n")
            .is_err()
        {
            return;
        }
        for _ in 0..10 {
            if socket.write_all(b" ").is_err() {
                break;
            }
            thread::sleep(Duration::from_millis(25));
        }
    });
    let temp = tempfile::tempdir().unwrap();
    let profiles = ApiProfiles::open(temp.path()).unwrap();
    let start = std::time::Instant::now();
    assert!(profiles
        .prepare_test(&draft(&url))
        .unwrap()
        .execute_with_timeout(Duration::from_millis(70))
        .is_err());
    assert!(start.elapsed() < Duration::from_millis(240));
    worker.join().unwrap();
}
