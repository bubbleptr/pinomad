use pinomad_core::noise::keypair_from_private;
use pinomad_core::secure_channel::{encode_host_hello, initiate_handshake, respond_handshake};
use rtc_spike_core::frame::bulk_frame;

#[test]
fn four_mib_business_frame_round_trips_as_real_noise_records() {
    let device = keypair_from_private(&[0x11; 32]).unwrap();
    let host = keypair_from_private(&[0x22; 32]).unwrap();
    let initiator = initiate_handshake(&device, host.public_key, None).unwrap();
    let mut responder = respond_handshake(&host).unwrap();
    let (hello, _remote) = responder.read_message1(initiator.message1()).unwrap();
    assert!(hello.contains("\"v\":1"));
    let (message2, mut responder_session) = responder.write_message2(&encode_host_hello()).unwrap();
    let (_host_hello, mut initiator_session, _hash) = initiator.read_message2(&message2).unwrap();

    let frame = bulk_frame(7);
    let records = initiator_session.seal(&frame).unwrap();
    assert!(records.len() > 1, "the frame must span multiple records");
    assert!(records.iter().all(|record| record.len() <= 65_535));
    println!("frame_bytes={} records={}", frame.len(), records.len());

    let mut received = None;
    for (index, record) in records.iter().enumerate() {
        let opened = responder_session.open(record).unwrap();
        if index + 1 < records.len() {
            assert!(opened.is_none());
        } else {
            received = opened;
        }
    }
    assert_eq!(received.as_deref(), Some(frame.as_str()));

    let echoed = responder_session.seal(&frame).unwrap();
    let mut round_trip = None;
    for (index, record) in echoed.iter().enumerate() {
        let opened = initiator_session.open(record).unwrap();
        if index + 1 == echoed.len() {
            round_trip = opened;
        }
    }
    assert_eq!(round_trip.as_deref(), Some(frame.as_str()));
}
