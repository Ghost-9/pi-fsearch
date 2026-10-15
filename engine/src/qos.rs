//! Thread QoS hints, portable across targets.
//!
//! `pthread_set_qos_class_self_np` and `qos_class_t` are Darwin-only libc
//! APIs. They are scheduling *hints*: on macOS the calls below are exactly the
//! old ones, and on other targets they are no-ops. Gating them is the first
//! slice of the Linux port (issue #32) — it removes the QoS errors from
//! `content.rs`, `engine.rs` and `fsevents.rs` without pretending the
//! whole-disk enumerator (`walk.rs`, still Darwin-only) exists.
//!
//! Deliberately not a generic abstraction: only the three classes the engine
//! uses are modelled, so the portable surface stays reviewable.

/// The QoS classes the engine assigns.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Qos {
    UserInteractive,
    UserInitiated,
    Utility,
}

#[cfg(target_os = "macos")]
pub fn set_self(qos: Qos) {
    let class = match qos {
        Qos::UserInteractive => libc::qos_class_t::QOS_CLASS_USER_INTERACTIVE,
        Qos::UserInitiated => libc::qos_class_t::QOS_CLASS_USER_INITIATED,
        Qos::Utility => libc::qos_class_t::QOS_CLASS_UTILITY,
    };
    // SAFETY: the function applies to the calling thread and is declared by
    // Darwin's libc; `class` is one of its own constants.
    unsafe { libc::pthread_set_qos_class_self_np(class, 0) };
}

/// No-op off macOS: there is no portable equivalent, and inventing a priority
/// value would change behaviour without a measurement. The thread keeps the
/// default scheduling class.
#[cfg(not(target_os = "macos"))]
pub fn set_self(_qos: Qos) {}

/// `QOS_CLASS_USER_INITIATED` as the raw `u32` a dispatch-queue attribute
/// wants. Off macOS it is `QOS_CLASS_UNSPECIFIED`; the only caller
/// (`fsevents.rs`) is a Darwin stream whose backend is still CoreServices.
#[cfg(target_os = "macos")]
pub const USER_INITIATED_DISPATCH_QOS: u32 = libc::qos_class_t::QOS_CLASS_USER_INITIATED as u32;
#[cfg(not(target_os = "macos"))]
pub const USER_INITIATED_DISPATCH_QOS: u32 = 0;
