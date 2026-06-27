import Foundation
import Combine

/// Represents a user profile fetched from the remote API.
struct UserProfile: Codable, Identifiable {
  let id: String
  let displayName: String
  let handle: String
  let avatarURL: URL?
  let bio: String?
  let createdAt: Date
}

/// Errors that can occur during profile operations.
enum ProfileError: LocalizedError {
  case notFound(userId: String)
  case networkUnavailable
  case rateLimited(retryAfter: TimeInterval)
  case unauthorized

  var errorDescription: String? {
    switch self {
    case .notFound(let userId): return "User \(userId) not found"
    case .networkUnavailable: return "Network connection unavailable"
    case .rateLimited(let retry): return "Rate limited, retry after \(retry)s"
    case .unauthorized: return "Authentication required"
    }
  }
}

/// Manages user profile data — fetching, caching, and updating.
@MainActor
final class ProfileService: ObservableObject {
  // MARK: - Published state

  @Published private(set) var currentProfile: UserProfile?
  @Published private(set) var isLoading = false
  @Published private(set) var error: ProfileError?

  // MARK: - Dependencies

  private let apiClient: APIClient
  private let cache: ProfileCache
  private var cancellables = Set<AnyCancellable>()

  // MARK: - Init

  init(apiClient: APIClient, cache: ProfileCache = .shared) {
    self.apiClient = apiClient
    self.cache = cache
  }

  // MARK: - Public API

  /// Fetch a user profile by ID, falling back to cache on network failure.
  func fetchProfile(for userId: String) async throws -> UserProfile {
    isLoading = true
    defer { isLoading = false }

    // Check cache first
    if let cached = await cache.profile(for: userId) {
      currentProfile = cached
      return cached
    }

    do {
      let profile = try await apiClient.request(.getProfile(userId))
      await cache.store(profile)
      currentProfile = profile
      return profile
    } catch let error as ProfileError {
      self.error = error
      throw error
    } catch {
      let wrapped = ProfileError.networkUnavailable
      self.error = wrapped
      throw wrapped
    }
  }

  /// Update the current user's display name.
  func updateDisplayName(_ newName: String) async throws {
    guard var profile = currentProfile else {
      throw ProfileError.unauthorized
    }

    let updated = try await apiClient.request(.updateProfile(
      userId: profile.id,
      fields: ["displayName": newName]
    ))

    profile = UserProfile(
      id: updated.id,
      displayName: updated.displayName,
      handle: profile.handle,
      avatarURL: profile.avatarURL,
      bio: profile.bio,
      createdAt: profile.createdAt
    )

    await cache.store(profile)
    currentProfile = profile
  }

  /// Clear local cache and reset state.
  func reset() async {
    await cache.clear()
    currentProfile = nil
    error = nil
    isLoading = false
  }

  // MARK: - Private

  private func observeNetworkChanges() {
    NotificationCenter.default
      .publisher(for: .networkStatusChanged)
      .sink { [weak self] notification in
        guard let available = notification.userInfo?["available"] as? Bool,
              available,
              let self,
              let lastError = self.error,
              case .networkUnavailable = lastError
        else { return }

        // Retry last fetch on network recovery
        if let profile = self.currentProfile {
          Task { try? await self.fetchProfile(for: profile.id) }
        }
      }
      .store(in: &cancellables)
  }
}
