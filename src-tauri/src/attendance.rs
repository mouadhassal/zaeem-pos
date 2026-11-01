//! Attendance punches: who came and left, whatever the way they said so.
//!
//! Every clock-in or clock-out (a manager's button, a fingerprint, a wall
//! clock's log) first becomes one row in `attendance_punches`, the raw record
//! that is never edited. The daily `attendance` row (what the Staff screen and
//! payroll read) is then derived from it. Several punches a day work (a split
//! shift is IN, OUT, IN, OUT); a person's next punch is IN unless their last
//! was an IN less than [`MAX_OPEN_SHIFT_HOURS`] ago, so a forgotten clock-out
//! from yesterday does not turn today's arrival into a departure.
//!
//! Fingerprint hardware sits behind [`FingerprintReader`]. The device is not
//! chosen yet, so the only reader today is [`NoReader`], which says plainly that
//! nothing is connected; everything around it (enrolment storage, matching to a
//! person, the punch, the late rule, the log) is real and tested with a fake
//! reader. Fingerprint templates never leave the device they were captured on.

use chrono::{DateTime, Local, NaiveTime, Timelike, Utc};
use rusqlite::{params, Connection, OptionalExtension};

/// A person whose last punch was an IN longer ago than this is treated as having
/// forgotten to clock out: their next punch is a new IN.
pub const MAX_OPEN_SHIFT_HOURS: i64 = 16;

/// The schema, shared by the migration and by the tests.
pub const SCHEMA_SQL: &str = "
CREATE TABLE IF NOT EXISTS attendance_punches (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    branch_id TEXT NOT NULL,
    user_id TEXT NOT NULL REFERENCES staff(id),
    punched_at TEXT NOT NULL,
    direction TEXT NOT NULL CHECK (direction IN ('IN','OUT')),
    source TEXT NOT NULL CHECK (source IN ('MANUAL','FINGERPRINT','DEVICE_IMPORT')),
    device_id TEXT,
    recorded_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_attendance_punches_user_time ON attendance_punches (user_id, punched_at);
CREATE INDEX IF NOT EXISTS idx_attendance_punches_branch_time ON attendance_punches (tenant_id, branch_id, punched_at);
CREATE TABLE IF NOT EXISTS fingerprint_enrolments (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    branch_id TEXT NOT NULL,
    user_id TEXT NOT NULL REFERENCES staff(id),
    finger TEXT NOT NULL,
    provider TEXT NOT NULL,
    template BLOB NOT NULL,
    enrolled_at TEXT NOT NULL,
    enrolled_by TEXT NOT NULL,
    UNIQUE (user_id, finger)
);
CREATE TABLE IF NOT EXISTS attendance_settings (
    tenant_id TEXT PRIMARY KEY,
    shift_start TEXT NOT NULL DEFAULT '09:00',
    late_grace_minutes INTEGER NOT NULL DEFAULT 10,
    min_gap_seconds INTEGER NOT NULL DEFAULT 60
);";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Direction {
    In,
    Out,
}

impl Direction {
    pub fn as_str(self) -> &'static str {
        match self {
            Direction::In => "IN",
            Direction::Out => "OUT",
        }
    }

    fn parse(s: &str) -> Direction {
        if s == "OUT" { Direction::Out } else { Direction::In }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    Manual,
    Fingerprint,
    #[allow(dead_code)] // the wall-clock import arrives with the device choice
    DeviceImport,
}

impl Source {
    pub fn as_str(self) -> &'static str {
        match self {
            Source::Manual => "MANUAL",
            Source::Fingerprint => "FINGERPRINT",
            Source::DeviceImport => "DEVICE_IMPORT",
        }
    }
}

/// When the day starts and how forgiving the late rule is. Defaults: 09:00, 10 minutes.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct AttendanceSettings {
    /// "HH:MM", local time.
    pub shift_start: String,
    pub late_grace_minutes: i64,
    /// A second punch inside this many seconds of the last is a double tap and is refused.
    pub min_gap_seconds: i64,
}

impl Default for AttendanceSettings {
    fn default() -> Self {
        AttendanceSettings { shift_start: "09:00".to_string(), late_grace_minutes: 10, min_gap_seconds: 60 }
    }
}

pub fn parse_hhmm(s: &str) -> Option<NaiveTime> {
    let (h, m) = s.split_once(':')?;
    if h.len() != 2 || m.len() != 2 {
        return None;
    }
    NaiveTime::from_hms_opt(h.parse().ok()?, m.parse().ok()?, 0)
}

pub fn load_settings(conn: &Connection, tenant_id: &str) -> Result<AttendanceSettings, String> {
    let row: Option<(String, i64, i64)> = conn
        .query_row(
            "SELECT shift_start, late_grace_minutes, min_gap_seconds FROM attendance_settings WHERE tenant_id = ?1",
            params![tenant_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    Ok(row
        .map(|(shift_start, late_grace_minutes, min_gap_seconds)| AttendanceSettings { shift_start, late_grace_minutes, min_gap_seconds })
        .unwrap_or_default())
}

pub fn save_settings(conn: &Connection, tenant_id: &str, shift_start: &str, late_grace_minutes: i64) -> Result<(), String> {
    if parse_hhmm(shift_start).is_none() {
        return Err("وقت بداية الدوام غير صالح، اكتبه بصيغة 09:00".to_string());
    }
    if !(0..=180).contains(&late_grace_minutes) {
        return Err("مهلة التأخير يجب أن تكون بين 0 و 180 دقيقة".to_string());
    }
    conn.execute(
        "INSERT INTO attendance_settings (tenant_id, shift_start, late_grace_minutes) VALUES (?1, ?2, ?3) \
         ON CONFLICT(tenant_id) DO UPDATE SET shift_start = ?2, late_grace_minutes = ?3",
        params![tenant_id, shift_start, late_grace_minutes],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// LATE once the local time is past the shift start plus the grace; PRESENT otherwise.
pub fn arrival_status(local_time: NaiveTime, s: &AttendanceSettings) -> &'static str {
    let start = parse_hhmm(&s.shift_start).unwrap_or_else(|| NaiveTime::from_hms_opt(9, 0, 0).expect("valid"));
    let limit_secs = start.num_seconds_from_midnight() as i64 + s.late_grace_minutes * 60;
    if local_time.num_seconds_from_midnight() as i64 > limit_secs { "LATE" } else { "PRESENT" }
}

/// The status for someone arriving at `now`, in the till's local time.
pub fn arrival_status_at(now: DateTime<Utc>, s: &AttendanceSettings) -> &'static str {
    arrival_status(now.with_timezone(&Local).time(), s)
}

/// What a person's next punch is, given their last one.
pub fn next_direction(last: Option<(Direction, DateTime<Utc>)>, now: DateTime<Utc>) -> Direction {
    match last {
        Some((Direction::In, at)) if (now - at).num_hours() < MAX_OPEN_SHIFT_HOURS => Direction::Out,
        _ => Direction::In,
    }
}

/// Appends one row to the raw punch log.
#[allow(clippy::too_many_arguments)]
pub fn log_punch(
    conn: &Connection,
    tenant_id: &str,
    branch_id: &str,
    user_id: &str,
    direction: Direction,
    source: Source,
    device_id: Option<&str>,
    recorded_by: Option<&str>,
    at: DateTime<Utc>,
) -> Result<String, String> {
    let id = uuid::Uuid::now_v7().to_string();
    conn.execute(
        "INSERT INTO attendance_punches (id, tenant_id, branch_id, user_id, punched_at, direction, source, device_id, recorded_by) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![id, tenant_id, branch_id, user_id, at.to_rfc3339(), direction.as_str(), source.as_str(), device_id, recorded_by],
    )
    .map_err(|e| e.to_string())?;
    Ok(id)
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct PunchOutcome {
    pub user_id: String,
    pub user_name: String,
    pub direction: &'static str,
    pub punched_at: String,
    pub status: String,
}

/// Records one punch for `user_id` and updates their daily attendance row. The
/// caller has already checked that the actor may see this person.
#[allow(clippy::too_many_arguments)]
pub fn record_punch(
    conn: &Connection,
    tenant_id: &str,
    branch_id: &str,
    user_id: &str,
    source: Source,
    device_id: Option<&str>,
    recorded_by: Option<&str>,
    now: DateTime<Utc>,
) -> Result<PunchOutcome, String> {
    let settings = load_settings(conn, tenant_id)?;
    let user_name: String = conn
        .query_row("SELECT name FROM staff WHERE id = ?1", params![user_id], |r| r.get(0))
        .map_err(|e| e.to_string())?;

    let last: Option<(Direction, DateTime<Utc>)> = conn
        .query_row(
            "SELECT direction, punched_at FROM attendance_punches WHERE user_id = ?1 ORDER BY punched_at DESC LIMIT 1",
            params![user_id],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .and_then(|(d, at)| DateTime::parse_from_rfc3339(&at).ok().map(|t| (Direction::parse(&d), t.with_timezone(&Utc))));

    if let Some((_, at)) = last {
        if (now - at).num_seconds().abs() < settings.min_gap_seconds {
            return Err("سُجّلت بصمتك قبل لحظات. انتظر قليلاً قبل المحاولة مرة أخرى".to_string());
        }
    }
    let direction = next_direction(last, now);
    log_punch(conn, tenant_id, branch_id, user_id, direction, source, device_id, recorded_by, now)?;

    let now_iso = now.to_rfc3339();
    let today = now.format("%Y-%m-%d").to_string();
    let status = match direction {
        Direction::In => {
            let row: Option<(String, Option<String>, String)> = conn
                .query_row(
                    "SELECT id, clock_in, status FROM attendance WHERE user_id = ?1 AND date = ?2",
                    params![user_id, today],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )
                .optional()
                .map_err(|e| e.to_string())?;
            match row {
                // The first arrival of the day decides late or not; coming back after a break does not change it.
                Some((id, Some(_), status)) => {
                    conn.execute("UPDATE attendance SET clock_out = NULL, last_modified = ?1, sync_status = 'pending' WHERE id = ?2", params![now_iso, id])
                        .map_err(|e| e.to_string())?;
                    status
                }
                Some((id, None, _)) => {
                    let status = arrival_status_at(now, &settings).to_string();
                    conn.execute(
                        "UPDATE attendance SET clock_in = ?1, clock_out = NULL, status = ?2, last_modified = ?1, sync_status = 'pending' WHERE id = ?3",
                        params![now_iso, status, id],
                    )
                    .map_err(|e| e.to_string())?;
                    status
                }
                None => {
                    let status = arrival_status_at(now, &settings).to_string();
                    conn.execute(
                        "INSERT INTO attendance (id, tenant_id, branch_id, user_id, date, clock_in, status, last_modified, sync_status) \
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?6, 'pending')",
                        params![uuid::Uuid::now_v7().to_string(), tenant_id, branch_id, user_id, today, now_iso, status],
                    )
                    .map_err(|e| e.to_string())?;
                    status
                }
            }
        }
        Direction::Out => {
            // The open day this departure closes: the latest arrival with no departure yet.
            let open: Option<(String, Option<String>, String)> = conn
                .query_row(
                    "SELECT id, clock_in, status FROM attendance WHERE user_id = ?1 AND clock_in IS NOT NULL AND clock_out IS NULL \
                     ORDER BY clock_in DESC LIMIT 1",
                    params![user_id],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )
                .optional()
                .map_err(|e| e.to_string())?;
            match open {
                Some((id, clock_in, mut status)) => {
                    let hours = clock_in
                        .as_deref()
                        .and_then(|c| DateTime::parse_from_rfc3339(c).ok())
                        .map(|c| (now.timestamp() - c.timestamp()) as f64 / 3600.0);
                    if let Some(h) = hours {
                        if h < 4.0 {
                            status = "HALF_DAY".to_string();
                        } else if status == "HALF_DAY" {
                            status = "PRESENT".to_string();
                        }
                    }
                    conn.execute(
                        "UPDATE attendance SET clock_out = ?1, status = ?2, last_modified = ?1, sync_status = 'pending' WHERE id = ?3",
                        params![now_iso, status, id],
                    )
                    .map_err(|e| e.to_string())?;
                    status
                }
                None => {
                    conn.execute(
                        "INSERT INTO attendance (id, tenant_id, branch_id, user_id, date, clock_out, status, last_modified, sync_status) \
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'PRESENT', ?6, 'pending')",
                        params![uuid::Uuid::now_v7().to_string(), tenant_id, branch_id, user_id, today, now_iso],
                    )
                    .map_err(|e| e.to_string())?;
                    "PRESENT".to_string()
                }
            }
        }
    };

    Ok(PunchOutcome { user_id: user_id.to_string(), user_name, direction: direction.as_str(), punched_at: now_iso, status })
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct PunchRow {
    pub id: String,
    pub user_id: String,
    pub user_name: String,
    pub punched_at: String,
    pub direction: String,
    pub source: String,
    pub recorded_by_name: Option<String>,
}

/// The raw punch log, newest first. `branch_id` narrows to one branch (a branch manager's scope).
pub fn list_punches(
    conn: &Connection,
    tenant_id: &str,
    branch_id: Option<&str>,
    date_from: Option<&str>,
    date_to: Option<&str>,
    user_id: Option<&str>,
) -> Result<Vec<PunchRow>, String> {
    let mut sql = String::from(
        "SELECT p.id, p.user_id, s.name, p.punched_at, p.direction, p.source, rb.name \
         FROM attendance_punches p JOIN staff s ON s.id = p.user_id LEFT JOIN staff rb ON rb.id = p.recorded_by \
         WHERE p.tenant_id = ?1",
    );
    let mut args: Vec<String> = vec![tenant_id.to_string()];
    let mut push = |sql_part: &str, v: &str| {
        args.push(v.to_string());
        sql.push_str(&format!(" AND {sql_part}?{}", args.len()));
    };
    if let Some(b) = branch_id {
        push("p.branch_id = ", b);
    }
    // Dates are the local calendar day the punch happened on.
    if let Some(f) = date_from {
        push("substr(p.punched_at, 1, 10) >= ", f);
    }
    if let Some(t) = date_to {
        push("substr(p.punched_at, 1, 10) <= ", t);
    }
    if let Some(u) = user_id {
        push("p.user_id = ", u);
    }
    sql.push_str(" ORDER BY p.punched_at DESC LIMIT 1000");
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let refs: Vec<&dyn rusqlite::ToSql> = args.iter().map(|a| a as &dyn rusqlite::ToSql).collect();
    let rows = stmt
        .query_map(refs.as_slice(), |r| {
            Ok(PunchRow { id: r.get(0)?, user_id: r.get(1)?, user_name: r.get(2)?, punched_at: r.get(3)?, direction: r.get(4)?, source: r.get(5)?, recorded_by_name: r.get(6)? })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Fingerprint readers
// ---------------------------------------------------------------------------

/// What the till knows about the attached fingerprint reader.
#[derive(Debug, Clone, serde::Serialize)]
pub struct ReaderStatus {
    pub connected: bool,
    pub model: Option<String>,
    /// Arabic, shown to the owner as is.
    pub message: String,
}

/// A fingerprint device. One implementation per supported model; the rest of
/// the app only knows this interface.
pub trait FingerprintReader: Send + Sync {
    /// Stored with each enrolment so templates are only matched by the reader that made them.
    fn provider(&self) -> &'static str;
    fn status(&self) -> ReaderStatus;
    /// Asks the person to place a finger and returns the template (enrolment).
    fn capture_template(&self) -> Result<Vec<u8>, String>;
    /// Asks for a finger and returns the id of the enrolment it matches, or None when it matches nobody.
    fn identify(&self, enrolments: &[(String, Vec<u8>)]) -> Result<Option<String>, String>;
}

/// The reader until a device is chosen: reports that nothing is connected.
pub struct NoReader;

pub const NO_READER_MESSAGE: &str = "لا يوجد جهاز بصمة متصل. بعد اختيار الجهاز وتركيبه سيعمل التسجيل هنا.";

impl FingerprintReader for NoReader {
    fn provider(&self) -> &'static str {
        "none"
    }
    fn status(&self) -> ReaderStatus {
        ReaderStatus { connected: false, model: None, message: NO_READER_MESSAGE.to_string() }
    }
    fn capture_template(&self) -> Result<Vec<u8>, String> {
        Err(NO_READER_MESSAGE.to_string())
    }
    fn identify(&self, _enrolments: &[(String, Vec<u8>)]) -> Result<Option<String>, String> {
        Err(NO_READER_MESSAGE.to_string())
    }
}

/// The reader the app holds, so a driver can be swapped in without touching a command.
pub struct ReaderState(pub std::sync::Mutex<Box<dyn FingerprintReader>>);

impl ReaderState {
    pub fn none() -> Self {
        ReaderState(std::sync::Mutex::new(Box::new(NoReader)))
    }
}

pub const FINGERS: [&str; 10] = [
    "right_thumb", "right_index", "right_middle", "right_ring", "right_little",
    "left_thumb", "left_index", "left_middle", "left_ring", "left_little",
];

#[derive(Debug, Clone, serde::Serialize)]
pub struct EnrolmentRow {
    pub id: String,
    pub user_id: String,
    pub user_name: String,
    pub finger: String,
    pub provider: String,
    pub enrolled_at: String,
}

/// Enrolments the actor may see. The template itself is never returned.
pub fn list_enrolments(conn: &Connection, tenant_id: &str, branch_id: Option<&str>) -> Result<Vec<EnrolmentRow>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT e.id, e.user_id, s.name, e.finger, e.provider, e.enrolled_at FROM fingerprint_enrolments e \
             JOIN staff s ON s.id = e.user_id WHERE e.tenant_id = ?1 AND (?2 IS NULL OR e.branch_id = ?2) ORDER BY s.name, e.finger",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![tenant_id, branch_id], |r| {
            Ok(EnrolmentRow { id: r.get(0)?, user_id: r.get(1)?, user_name: r.get(2)?, finger: r.get(3)?, provider: r.get(4)?, enrolled_at: r.get(5)? })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

#[allow(clippy::too_many_arguments)]
pub fn save_enrolment(
    conn: &Connection,
    tenant_id: &str,
    branch_id: &str,
    user_id: &str,
    finger: &str,
    provider: &str,
    template: &[u8],
    enrolled_by: &str,
) -> Result<String, String> {
    if !FINGERS.contains(&finger) {
        return Err("إصبع غير معروف".to_string());
    }
    if template.is_empty() {
        return Err("لم يلتقط الجهاز بصمة صالحة، حاول مرة أخرى".to_string());
    }
    let id = uuid::Uuid::now_v7().to_string();
    // Re-enrolling the same finger replaces the old template.
    conn.execute("DELETE FROM fingerprint_enrolments WHERE user_id = ?1 AND finger = ?2", params![user_id, finger])
        .map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO fingerprint_enrolments (id, tenant_id, branch_id, user_id, finger, provider, template, enrolled_at, enrolled_by) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![id, tenant_id, branch_id, user_id, finger, provider, template, Utc::now().to_rfc3339(), enrolled_by],
    )
    .map_err(|e| e.to_string())?;
    Ok(id)
}

/// Templates a reader may be asked to match against: this branch's, made by this reader's provider,
/// for staff who are still active.
pub fn templates_for_matching(conn: &Connection, tenant_id: &str, branch_id: &str, provider: &str) -> Result<Vec<(String, Vec<u8>)>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT e.id, e.template FROM fingerprint_enrolments e JOIN staff s ON s.id = e.user_id \
             WHERE e.tenant_id = ?1 AND e.branch_id = ?2 AND e.provider = ?3 AND s.is_active = 1",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![tenant_id, branch_id, provider], |r| Ok((r.get::<_, String>(0)?, r.get::<_, Vec<u8>>(1)?)))
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE staff (id TEXT PRIMARY KEY, tenant_id TEXT, branch_id TEXT, name TEXT NOT NULL, is_active INTEGER NOT NULL DEFAULT 1);
             CREATE TABLE attendance (id TEXT PRIMARY KEY, tenant_id TEXT, branch_id TEXT, user_id TEXT NOT NULL, date TEXT NOT NULL,
                clock_in TEXT, clock_out TEXT, status TEXT NOT NULL DEFAULT 'PRESENT', last_modified TEXT, sync_status TEXT);
             INSERT INTO staff (id, tenant_id, branch_id, name) VALUES ('u1', 't1', 'b1', 'Ahmad'), ('u2', 't1', 'b1', 'Laila'), ('boss', 't1', 'b1', 'Boss');",
        )
        .unwrap();
        conn.execute_batch(SCHEMA_SQL).unwrap();
        conn
    }

    fn at(day: u32, h: u32, m: u32) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 11, day, h, m, 0).unwrap()
    }

    fn punch(conn: &Connection, user: &str, when: DateTime<Utc>) -> Result<PunchOutcome, String> {
        record_punch(conn, "t1", "b1", user, Source::Fingerprint, Some("dev"), None, when)
    }

    #[test]
    fn the_late_rule_follows_the_shift_start_and_the_grace() {
        let s = AttendanceSettings::default(); // 09:00 + 10 min
        let t = |h, m, sec| NaiveTime::from_hms_opt(h, m, sec).unwrap();
        assert_eq!(arrival_status(t(8, 55, 0), &s), "PRESENT");
        assert_eq!(arrival_status(t(9, 0, 0), &s), "PRESENT");
        assert_eq!(arrival_status(t(9, 10, 0), &s), "PRESENT", "exactly at the end of the grace is still on time");
        assert_eq!(arrival_status(t(9, 10, 1), &s), "LATE");
        let strict = AttendanceSettings { late_grace_minutes: 0, ..AttendanceSettings::default() };
        assert_eq!(arrival_status(t(9, 0, 1), &strict), "LATE");
        let evening = AttendanceSettings { shift_start: "17:30".to_string(), late_grace_minutes: 15, ..AttendanceSettings::default() };
        assert_eq!(arrival_status(t(17, 44, 0), &evening), "PRESENT");
        assert_eq!(arrival_status(t(17, 46, 0), &evening), "LATE");
    }

    #[test]
    fn hhmm_is_strict() {
        assert!(parse_hhmm("09:00").is_some());
        assert!(parse_hhmm("23:59").is_some());
        for bad in ["9:00", "24:00", "09:60", "0900", "", "09:0", "ab:cd"] {
            assert!(parse_hhmm(bad).is_none(), "{bad}");
        }
    }

    #[test]
    fn settings_default_then_save_and_validate() {
        let conn = db();
        assert_eq!(load_settings(&conn, "t1").unwrap(), AttendanceSettings::default());
        save_settings(&conn, "t1", "10:30", 5).unwrap();
        let s = load_settings(&conn, "t1").unwrap();
        assert_eq!((s.shift_start.as_str(), s.late_grace_minutes), ("10:30", 5));
        save_settings(&conn, "t1", "11:00", 0).unwrap(); // overwrite, not a second row
        assert_eq!(load_settings(&conn, "t1").unwrap().shift_start, "11:00");
        assert!(save_settings(&conn, "t1", "25:00", 5).is_err());
        assert!(save_settings(&conn, "t1", "09:00", 181).is_err());
        assert!(save_settings(&conn, "t1", "09:00", -1).is_err());
        assert_eq!(load_settings(&conn, "t2").unwrap(), AttendanceSettings::default(), "another business keeps the defaults");
    }

    #[test]
    fn punches_alternate_in_and_out_and_build_the_daily_row() {
        let conn = db();
        let a = punch(&conn, "u1", at(1, 6, 0)).unwrap();
        assert_eq!(a.direction, "IN");
        let b = punch(&conn, "u1", at(1, 14, 0)).unwrap();
        assert_eq!(b.direction, "OUT");
        let rows: Vec<(String, Option<String>, Option<String>)> = conn
            .prepare("SELECT status, clock_in, clock_out FROM attendance WHERE user_id = 'u1'").unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).unwrap().map(|r| r.unwrap()).collect();
        assert_eq!(rows.len(), 1, "one daily row for the day");
        assert!(rows[0].1.is_some() && rows[0].2.is_some());
        assert_ne!(rows[0].0, "HALF_DAY", "eight hours is a full day");
        let log = list_punches(&conn, "t1", None, None, None, Some("u1")).unwrap();
        assert_eq!(log.len(), 2);
        assert_eq!(log[0].direction, "OUT", "newest first");
        assert!(log.iter().all(|p| p.source == "FINGERPRINT"));
    }

    #[test]
    fn a_short_stay_is_a_half_day_and_a_longer_return_repairs_it() {
        let conn = db();
        punch(&conn, "u1", at(1, 6, 0)).unwrap();
        let out = punch(&conn, "u1", at(1, 8, 0)).unwrap();
        assert_eq!(out.status, "HALF_DAY");
        // Back after a break and works on: the day is no longer a half day.
        punch(&conn, "u1", at(1, 9, 0)).unwrap();
        let out = punch(&conn, "u1", at(1, 15, 0)).unwrap();
        assert_eq!(out.status, "PRESENT");
    }

    #[test]
    fn a_split_shift_keeps_one_row_and_the_first_arrival() {
        let conn = db();
        punch(&conn, "u1", at(1, 6, 0)).unwrap();
        punch(&conn, "u1", at(1, 10, 0)).unwrap();
        let back = punch(&conn, "u1", at(1, 12, 0)).unwrap();
        assert_eq!(back.direction, "IN");
        let (n, clock_out): (i64, Option<String>) = conn
            .query_row("SELECT COUNT(*), MAX(clock_out) FROM attendance WHERE user_id = 'u1'", [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        assert_eq!(n, 1);
        assert!(clock_out.is_none(), "back at work: not clocked out");
        let out = punch(&conn, "u1", at(1, 18, 0)).unwrap();
        assert_eq!(out.direction, "OUT");
    }

    #[test]
    fn a_double_tap_is_refused_and_not_logged() {
        let conn = db();
        punch(&conn, "u1", at(1, 6, 0)).unwrap();
        let again = record_punch(&conn, "t1", "b1", "u1", Source::Fingerprint, None, None, at(1, 6, 0) + chrono::Duration::seconds(20));
        assert!(again.is_err());
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM attendance_punches", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1);
        assert!(punch(&conn, "u1", at(1, 6, 0) + chrono::Duration::seconds(90)).is_ok(), "a minute later is a real punch");
    }

    #[test]
    fn a_forgotten_clock_out_does_not_turn_tomorrows_arrival_into_a_departure() {
        let conn = db();
        punch(&conn, "u1", at(1, 17, 0)).unwrap(); // arrives, never leaves
        let next = punch(&conn, "u1", at(2, 17, 0)).unwrap(); // 24 h later
        assert_eq!(next.direction, "IN");
        assert_eq!(next_direction(Some((Direction::In, at(1, 17, 0))), at(2, 8, 0)), Direction::Out, "15 h later is still the same shift");
        assert_eq!(next_direction(Some((Direction::In, at(1, 17, 0))), at(2, 9, 30)), Direction::In, "16 h+ later is a new arrival");
        assert_eq!(next_direction(Some((Direction::Out, at(1, 17, 0))), at(1, 18, 0)), Direction::In);
        assert_eq!(next_direction(None, at(1, 18, 0)), Direction::In);
    }

    #[test]
    fn people_are_independent() {
        let conn = db();
        punch(&conn, "u1", at(1, 6, 0)).unwrap();
        let other = punch(&conn, "u2", at(1, 6, 0)).unwrap();
        assert_eq!(other.direction, "IN", "Laila's first punch is an arrival whatever Ahmad did");
        assert_eq!(list_punches(&conn, "t1", None, None, None, None).unwrap().len(), 2);
    }

    #[test]
    fn the_log_filters_by_branch_person_and_day() {
        let conn = db();
        punch(&conn, "u1", at(1, 6, 0)).unwrap();
        punch(&conn, "u1", at(2, 6, 0)).unwrap();
        record_punch(&conn, "t1", "b2", "u2", Source::Manual, None, Some("boss"), at(1, 7, 0)).unwrap();
        assert_eq!(list_punches(&conn, "t1", Some("b2"), None, None, None).unwrap().len(), 1);
        assert_eq!(list_punches(&conn, "t1", Some("b1"), None, None, None).unwrap().len(), 2);
        assert_eq!(list_punches(&conn, "t1", None, Some("2026-11-02"), Some("2026-11-02"), None).unwrap().len(), 1);
        assert_eq!(list_punches(&conn, "t2", None, None, None, None).unwrap().len(), 0, "another business sees nothing");
        let manual = list_punches(&conn, "t1", Some("b2"), None, None, None).unwrap();
        assert_eq!(manual[0].recorded_by_name.as_deref(), Some("Boss"));
        assert_eq!(manual[0].source, "MANUAL");
    }

    // ---- readers ----

    /// A pretend reader: a "finger" is the user id, a template is those bytes.
    struct FakeReader {
        finger_on_glass: std::sync::Mutex<Option<Vec<u8>>>,
    }

    impl FingerprintReader for FakeReader {
        fn provider(&self) -> &'static str {
            "fake"
        }
        fn status(&self) -> ReaderStatus {
            ReaderStatus { connected: true, model: Some("Fake 1".into()), message: "ok".into() }
        }
        fn capture_template(&self) -> Result<Vec<u8>, String> {
            self.finger_on_glass.lock().unwrap().clone().ok_or("no finger".to_string())
        }
        fn identify(&self, enrolments: &[(String, Vec<u8>)]) -> Result<Option<String>, String> {
            let finger = self.finger_on_glass.lock().unwrap().clone().ok_or("no finger".to_string())?;
            Ok(enrolments.iter().find(|(_, t)| *t == finger).map(|(id, _)| id.clone()))
        }
    }

    #[test]
    fn without_a_device_nothing_can_be_enrolled_or_matched() {
        let r = NoReader;
        assert!(!r.status().connected);
        assert!(r.capture_template().is_err());
        assert!(r.identify(&[]).is_err());
        assert!(r.status().message.contains("لا يوجد جهاز"));
    }

    #[test]
    fn enrol_then_identify_then_punch_end_to_end() {
        let conn = db();
        let reader = FakeReader { finger_on_glass: std::sync::Mutex::new(Some(b"ahmad-right-index".to_vec())) };
        let template = reader.capture_template().unwrap();
        save_enrolment(&conn, "t1", "b1", "u1", "right_index", reader.provider(), &template, "boss").unwrap();
        *reader.finger_on_glass.lock().unwrap() = Some(b"laila-left-thumb".to_vec());
        let template = reader.capture_template().unwrap();
        save_enrolment(&conn, "t1", "b1", "u2", "left_thumb", reader.provider(), &template, "boss").unwrap();

        // Ahmad puts his finger on the glass.
        *reader.finger_on_glass.lock().unwrap() = Some(b"ahmad-right-index".to_vec());
        let candidates = templates_for_matching(&conn, "t1", "b1", reader.provider()).unwrap();
        assert_eq!(candidates.len(), 2);
        let enrolment_id = reader.identify(&candidates).unwrap().expect("matches");
        let user: String = conn.query_row("SELECT user_id FROM fingerprint_enrolments WHERE id = ?1", params![enrolment_id], |r| r.get(0)).unwrap();
        assert_eq!(user, "u1");
        let out = record_punch(&conn, "t1", "b1", &user, Source::Fingerprint, Some("till-1"), None, at(1, 6, 0)).unwrap();
        assert_eq!((out.user_name.as_str(), out.direction), ("Ahmad", "IN"));

        // A stranger matches nobody: no punch happens.
        *reader.finger_on_glass.lock().unwrap() = Some(b"stranger".to_vec());
        assert_eq!(reader.identify(&candidates).unwrap(), None);
    }

    #[test]
    fn enrolments_are_checked_listed_without_templates_and_replaced_not_duplicated() {
        let conn = db();
        assert!(save_enrolment(&conn, "t1", "b1", "u1", "pinky_toe", "fake", b"x", "boss").is_err(), "not a finger");
        assert!(save_enrolment(&conn, "t1", "b1", "u1", "right_index", "fake", b"", "boss").is_err(), "empty capture");
        save_enrolment(&conn, "t1", "b1", "u1", "right_index", "fake", b"first", "boss").unwrap();
        save_enrolment(&conn, "t1", "b1", "u1", "right_index", "fake", b"second", "boss").unwrap();
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM fingerprint_enrolments", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1, "re-enrolling a finger replaces it");
        let stored: Vec<u8> = conn.query_row("SELECT template FROM fingerprint_enrolments", [], |r| r.get(0)).unwrap();
        assert_eq!(stored, b"second");
        let listed = list_enrolments(&conn, "t1", None).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].user_name, "Ahmad");
        assert!(!format!("{:?}", listed[0]).contains("second"), "the template is never listed");
        assert_eq!(list_enrolments(&conn, "t1", Some("b2")).unwrap().len(), 0);
        assert_eq!(list_enrolments(&conn, "t2", None).unwrap().len(), 0);
    }

    #[test]
    fn matching_only_considers_this_branch_this_reader_and_active_staff() {
        let conn = db();
        save_enrolment(&conn, "t1", "b1", "u1", "right_index", "fake", b"a", "boss").unwrap();
        save_enrolment(&conn, "t1", "b1", "u2", "right_index", "other-brand", b"b", "boss").unwrap();
        save_enrolment(&conn, "t1", "b2", "boss", "right_index", "fake", b"c", "boss").unwrap();
        assert_eq!(templates_for_matching(&conn, "t1", "b1", "fake").unwrap().len(), 1);
        conn.execute("UPDATE staff SET is_active = 0 WHERE id = 'u1'", []).unwrap();
        assert_eq!(templates_for_matching(&conn, "t1", "b1", "fake").unwrap().len(), 0, "someone who left cannot clock in");
    }
}
