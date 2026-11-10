import Foundation
import SystemConfiguration

enum MiniNetwork {
    static func applyingSystemProxy(to environment: [String: String]) -> [String: String] {
        if hasValue(in: environment, for: "ALL_PROXY") { return environment }
        guard let settings = SCDynamicStoreCopyProxies(nil) as? [String: Any] else {
            return environment
        }

        var result = environment
        for scheme in ["HTTP", "HTTPS"] {
            let key = "\(scheme)_PROXY"
            guard !hasValue(in: environment, for: key),
                  (settings["\(scheme)Enable"] as? NSNumber)?.boolValue == true,
                  let host = settings["\(scheme)Proxy"] as? String, !host.isEmpty,
                  let port = settings["\(scheme)Port"] as? Int, (1...65_535).contains(port)
            else { continue }

            var components = URLComponents()
            components.scheme = "http"
            components.host = host
            components.port = port
            result[key] = components.url?.absoluteString
        }

        if !hasValue(in: environment, for: "NO_PROXY"),
           let exceptions = settings[kSCPropNetProxiesExceptionsList as String] as? [String],
           !exceptions.isEmpty {
            result["NO_PROXY"] = exceptions.map { pattern in
                pattern.hasPrefix("*.") ? String(pattern.dropFirst()) : pattern
            }.joined(separator: ",")
        }
        return result
    }

    private static func hasValue(in environment: [String: String], for key: String) -> Bool {
        [key, key.lowercased()].contains { environment[$0]?.isEmpty == false }
    }
}
