import PinomadChat
import PinomadCore
import SwiftUI

/// Add or edit a custom endpoint (ADR-0031). The key field is write-only:
/// the host never sends a stored key back, so editing leaves it empty and
/// an empty field keeps what is stored.
struct CustomEndpointView: View {
    let model: AppModel
    /// The endpoint being edited; nil adds one.
    let providerId: String?

    @Environment(\.dismiss) private var dismiss
    @Environment(\.popToProviders) private var popToProviders
    @State private var loaded = false
    @State private var name = ""
    @State private var api: CustomProviderApi = .openaiCompletions
    @State private var baseUrl = ""
    @State private var urlTouched = false
    @State private var apiKey = ""
    @State private var models = ""
    @State private var fetching = false
    @State private var fetchProblem: String?
    @State private var saving = false
    @State private var saveError: String?
    @State private var submitted = false
    @State private var confirmingRemove = false
    @State private var removeError: String?
    @FocusState private var urlFocused: Bool

    private var all: [ProviderInfo] { model.providers?.providers ?? [] }
    private var existing: ProviderInfo? { providerId.flatMap { id in all.first { $0.id == id } } }

    var body: some View {
        let connected = model.connected
        let urlProblem = baseUrlProblem(baseUrl)
        let modelList = endpointModels(models)
        let nameProblem = customEndpointNameProblem(
            name, editing: providerId != nil, providers: all, submitted: submitted)
        Form {
            Section {
                TextField("Name", text: $name, prompt: Text(verbatim: "Ollama on studio"))
            } header: {
                Text("Name")
            } footer: {
                if let nameProblem { InlineError(message: nameProblem) }
            }

            Section {
                Picker("API format", selection: $api) {
                    ForEach(CustomProviderApi.all, id: \.self) { api in
                        Text(api.label).tag(api)
                    }
                }
                // Verbatim: a string-literal prompt renders the URL as a link.
                TextField("Base URL", text: $baseUrl, prompt: Text(verbatim: "http://localhost:11434/v1"))
                    .keyboardType(.URL)
                    .textContentType(.URL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .focused($urlFocused)
                    // A half-typed URL isn't an error until the field is left.
                    .onChange(of: urlFocused) { _, focused in if !focused { urlTouched = true } }
                SecureField(
                    existing?.stored == nil ? "API key (not needed for local servers)" : "API key (empty keeps the stored key)",
                    text: $apiKey)
            } header: {
                Text("Endpoint")
            } footer: {
                if urlTouched, let urlProblem {
                    InlineError(message: urlProblem)
                } else {
                    Text("Ollama, LM Studio, vLLM and most gateways speak OpenAI Chat Completions.")
                }
            }

            Section {
                // A text editor: Return in a vertical text field ends editing.
                TextEditor(text: $models)
                    .font(.body.monospaced())
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .frame(minHeight: 88)
                    .overlay(alignment: .topLeading) {
                        if models.isEmpty {
                            Text("One model ID per line")
                                .font(.body.monospaced())
                                .foregroundStyle(.tertiary)
                                .padding(.top, 8)
                                .padding(.leading, 5)
                                .allowsHitTesting(false)
                        }
                    }
                Button {
                    Task { await fetchModels() }
                } label: {
                    HStack {
                        Text(fetching ? "Fetching…" : "Fetch from /models")
                        Spacer()
                        if fetching { ProgressView() }
                    }
                }
                .disabled(fetching)
            } header: {
                HStack {
                    Text("Models")
                    Spacer()
                    if !modelList.isEmpty {
                        Text("\(modelList.count)").monospacedDigit()
                    }
                }
            } footer: {
                if let fetchProblem {
                    Text(fetchProblem).foregroundStyle(.orange)
                } else if submitted && modelList.isEmpty {
                    InlineError(message: "Add at least one model")
                } else {
                    Text("Model IDs as the endpoint names them, asked from the host — it may be the only machine that reaches the endpoint.")
                }
            }

            Section {
                Button {
                    Task { await save() }
                } label: {
                    HStack {
                        Text(providerId == nil ? "Add endpoint" : "Save changes")
                        Spacer()
                        if saving { ProgressView() }
                    }
                }
                .disabled(saving)
            } footer: {
                if let saveError { InlineError(message: saveError) }
            }

            if providerId != nil {
                Section {
                    Button("Remove endpoint…", role: .destructive) { confirmingRemove = true }
                        .confirmationDialog("Remove this endpoint?", isPresented: $confirmingRemove, titleVisibility: .visible) {
                            Button("Remove endpoint", role: .destructive) {
                                guard let id = providerId else { return }
                                Task {
                                    do {
                                        try await model.removeCustomProvider(id)
                                        popToProviders()
                                    } catch {
                                        removeError = model.describe(error)
                                    }
                                }
                            }
                        } message: {
                            Text("Its models disappear from the model picker, and conversations using them stop.")
                        }
                } footer: {
                    if let removeError { InlineError(message: removeError) }
                }
            }
        }
        .disabled(!connected)
        .navigationTitle(existing.map { "Edit \($0.name)" } ?? "Custom endpoint")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear(perform: load)
        // Removed elsewhere while open: nothing left to edit.
        .onChange(of: providerId != nil && existing == nil) { _, gone in
            if gone && model.providers != nil && !saving { dismiss() }
        }
    }

    private func load() {
        guard !loaded else { return }
        loaded = true
        guard let existing, let custom = existing.custom else { return }
        name = existing.name
        api = custom.api
        baseUrl = custom.baseUrl
        models = custom.models.joined(separator: "\n")
    }

    private var fetchForm: EndpointModelsFetch {
        EndpointModelsFetch(api: api, baseUrl: baseUrl, apiKey: apiKey, models: models)
    }

    private func fetchModels() async {
        urlTouched = true
        guard baseUrlProblem(baseUrl) == nil else { return }
        fetching = true
        fetchProblem = nil
        defer { fetching = false }
        // The answer is for the endpoint as it is now, not as it is when it lands.
        let asked = fetchForm
        do {
            let listed = try await model.listEndpointModels(
                api: api, baseUrl: baseUrl.trimmingCharacters(in: .whitespacesAndNewlines),
                apiKey: apiKey.isEmpty ? nil : apiKey, providerId: providerId)
            guard asked.answers(fetchForm) else { return }
            if listed.isEmpty {
                fetchProblem = "The endpoint listed no models. Enter model IDs by hand."
            } else if asked.fills(fetchForm) {
                models = listed.joined(separator: "\n")
            }
        } catch {
            guard asked.answers(fetchForm) else { return }
            fetchProblem = "\(model.describe(error)) Enter model IDs by hand."
        }
    }

    private func save() async {
        submitted = true
        urlTouched = true
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let modelList = endpointModels(models)
        guard !trimmed.isEmpty,
              customEndpointNameProblem(name, editing: providerId != nil, providers: all, submitted: true) == nil,
              baseUrlProblem(baseUrl) == nil, !modelList.isEmpty
        else { return }
        saving = true
        saveError = nil
        let input = CustomProviderInput(
            id: providerId ?? customEndpointId(trimmed), name: trimmed, api: api,
            baseUrl: baseUrl.trimmingCharacters(in: .whitespacesAndNewlines), models: modelList)
        do {
            try await model.saveCustomProvider(input, apiKey: apiKey.isEmpty ? .keep : .set(key: apiKey))
            popToProviders()
        } catch {
            saveError = model.describe(error)
            saving = false
        }
    }
}
