import SwiftUI

/// A profile card view that displays user information with avatar and stats.
struct ProfileCardView: View {
  @StateObject private var viewModel = ProfileViewModel()
  @Environment(\.colorScheme) var colorScheme

  var body: some View {
    VStack(spacing: 16) {
      // Avatar section
      HStack {
        Image(systemName: "person.circle.fill")
          .resizable()
          .frame(width: 60, height: 60)
          .foregroundColor(.accentColor)

        VStack(alignment: .leading, spacing: 4) {
          Text(viewModel.userName)
            .font(.title2)
            .bold()

          Text(viewModel.userHandle)
            .font(.subheadline)
            .foregroundColor(.secondary)
        }

        Spacer()

        Button(action: { viewModel.toggleFollow() }) {
          Text(viewModel.isFollowing ? "Following" : "Follow")
            .font(.caption)
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
        }
        .buttonStyle(.borderedProminent)
      }
      .padding(.horizontal)

      Divider()

      // Stats row
      HStack(spacing: 32) {
        VStack {
          Text("\(viewModel.postCount)")
            .font(.headline)
          Text("Posts")
            .font(.caption)
            .foregroundColor(.secondary)
        }

        VStack {
          Text("\(viewModel.followerCount)")
            .font(.headline)
          Text("Followers")
            .font(.caption)
            .foregroundColor(.secondary)
        }

        VStack {
          Text("\(viewModel.followingCount)")
            .font(.headline)
          Text("Following")
            .font(.caption)
            .foregroundColor(.secondary)
        }
      }

      // Recent posts
      ScrollView(.horizontal, showsIndicators: false) {
        LazyHStack(spacing: 12) {
          ForEach(viewModel.recentPosts) { post in
            PostThumbnailView(post: post)
          }
        }
        .padding(.horizontal)
      }
    }
    .padding(.vertical)
    .background(Color(.systemBackground))
    .cornerRadius(12)
    .shadow(radius: 2)
  }
}

/// A small thumbnail view for a recent post.
struct PostThumbnailView: View {
  let post: PostItem

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      Text(post.title)
        .font(.caption)
        .lineLimit(1)

      Text(post.excerpt)
        .font(.caption2)
        .foregroundColor(.secondary)
        .lineLimit(2)
    }
    .frame(width: 120)
    .padding(8)
    .background(Color(.secondarySystemBackground))
    .cornerRadius(8)
  }
}
