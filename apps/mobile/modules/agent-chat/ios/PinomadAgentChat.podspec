require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

# Spike: AgentChatKit is consumed as a local SwiftPM package. RN's
# `spm_dependency` turns an existing path into an XCLocalSwiftPackageReference
# on the Pods project, so builds work without CocoaPods knowing about SPM.
# For EAS this must instead be a path inside the repo (vendored package) or a
# remote `url:` + `requirement:` once AgentChatKit is public.
agent_chat_kit_path = File.expand_path(File.join(Dir.home, 'code/opensource/agent-chat-expo-embed'))

Pod::Spec.new do |s|
  s.name           = 'PinomadAgentChat'
  s.version        = package['version']
  s.summary        = package['description']
  s.description    = package['description']
  s.author         = ''
  s.homepage       = 'https://github.com/bubbleptr/pinomad'
  # AgentChatKit's spike branch builds at iOS 18. Expo refuses to link a pod
  # whose deployment target is above the app's, so app.json pins the whole
  # app at iOS 18.0 for this spike.
  s.platforms      = {
    :ios => '18.0',
  }
  s.swift_version  = '6.0'
  s.source         = { git: 'https://github.com/bubbleptr/pinomad.git' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  if File.exist?(agent_chat_kit_path)
    spm_dependency(s,
      url: agent_chat_kit_path,
      requirement: { kind: 'exactVersion', version: '0.0.0' },
      products: ['AgentChatKit', 'AgentChatCore'],
    )
  else
    Pod::UI.warn "PinomadAgentChat: AgentChatKit checkout not found at #{agent_chat_kit_path}; the pod will build without the native transcript"
  end

  s.source_files = "**/*.{h,m,swift}"
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
end
