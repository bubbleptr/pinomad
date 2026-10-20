import Testing
@testable import PinomadChat

/// Pairing registers the hardware model name, so two phones with the same
/// owner-facing name stay distinguishable in the host's device list.
@Suite struct DeviceModelNameTests {
    @Test func knownIdentifiersUseTheMarketingName() {
        #expect(DeviceModelName.displayName(identifier: "iPhone18,1", fallback: "iPhone") == "iPhone 17 Pro")
        #expect(DeviceModelName.displayName(identifier: "iPhone12,1", fallback: "iPhone") == "iPhone 11")
        #expect(DeviceModelName.displayName(identifier: "iPhone14,6", fallback: "iPhone") == "iPhone SE (3rd generation)")
    }

    /// A model released after this table is still more distinguishable as
    /// its identifier than as the generic "iPhone".
    @Test func unknownIdentifiersStayRaw() {
        #expect(DeviceModelName.displayName(identifier: "iPhone19,1", fallback: "iPhone") == "iPhone19,1")
    }

    @Test func emptyIdentifiersUseTheFallback() {
        #expect(DeviceModelName.displayName(identifier: "", fallback: "iPhone") == "iPhone")
        #expect(DeviceModelName.displayName(identifier: "  \n", fallback: "iPhone") == "iPhone")
    }

    /// The simulator's `uname` reports the host CPU; only its runtime
    /// environment names the simulated phone.
    @Test func simulatorUsesTheSimulatedModelNotHostCPU() {
        #expect(DeviceModelName.currentIdentifier(
            environment: ["SIMULATOR_MODEL_IDENTIFIER": "iPhone18,1"],
            machine: "arm64") == "iPhone18,1")
        #expect(DeviceModelName.currentIdentifier(environment: [:], machine: "iPhone18,1") == "iPhone18,1")
        #expect(DeviceModelName.currentDisplayName(
            fallback: "iPhone",
            environment: ["SIMULATOR_MODEL_IDENTIFIER": "iPhone18,1"],
            machine: "arm64") == "iPhone 17 Pro")
    }
}
