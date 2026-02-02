"use client";

import React, { useState, useEffect, useRef, useCallback } from "react";
import axios from "axios";
import apiClient from "../utils/apiClient";
import {
  ForumPreviewProps,
  ForumPostsResponse,
  ForumPost,
  PostStatusResponse,
  CreatePostResponse,
  UpdatePostResponse,
  DeletePostResponse,
  LikePostResponse,
  ModerationErrorResponse,
  Attachment,
  UploadImageResponse,
  GamesListResponse,
  Game,
  ReplyResponse,
} from "../../types";

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:5000";

// Helper function to extract URL from attachment (handles both string and object)
const getAttachmentUrl = (attachment: Attachment): string => {
  if (typeof attachment === "string") {
    return attachment;
  }
  if (attachment && typeof attachment === "object" && "url" in attachment) {
    return attachment.url;
  }
  return "";
};

// Thread indent per nesting level (matches main app reply indentation)
const THREAD_INDENT_PX = 24;

/** Match @Username or @DisplayName at the start of post content. Returns the mentioned username or null. */
function getReplyMention(content: string | undefined): string | null {
  if (!content || typeof content !== "string") return null;
  const trimmed = content.trim();
  const match = trimmed.match(/^@(\S+)/);
  return match ? match[1] : null;
}

/** Build a depth-first ordered list of posts with depth for thread rendering.
 * Top-level posts first, then each post's replies directly under it (sorted by timestamp),
 * then nested replies under those, etc. Same ordering as Reddit/main app.
 * Handles: nested (post.replies), flat (parentPostId), or fallback via @mention in content.
 */
function buildThreadOrder(
  posts: ForumPost[]
): Array<{ post: ForumPost; depth: number }> {
  const result: Array<{ post: ForumPost; depth: number }> = [];
  const seen = new Set<string>();
  const list = (posts || []).filter((p) => p);
  const sortByTime = (a: ForumPost, b: ForumPost) =>
    new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime();
  const sortByTimeDesc = (a: ForumPost, b: ForumPost) =>
    new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();

  const pushOnce = (post: ForumPost, depth: number): boolean => {
    const id = post.postId ?? "";
    if (id && seen.has(id)) return false;
    if (id) seen.add(id);
    result.push({ post, depth });
    return true;
  };

  const topLevel = list.filter((p) => !p.parentPostId);
  const hasFlatReplies = list.some((p) => p.parentPostId != null);
  const hasNestedReplies = list.some((p) => (p.replies || []).length > 0);

  if (hasFlatReplies && topLevel.length > 0) {
    // Flat list: build tree by parentPostId, then depth-first walk
    const byParent = new Map<string | null, ForumPost[]>();
    topLevel.forEach((p) => {
      const arr = byParent.get(null) || [];
      arr.push(p);
      byParent.set(null, arr);
    });
    list.forEach((p) => {
      if (p.parentPostId != null) {
        const arr = byParent.get(p.parentPostId) || [];
        arr.push(p);
        byParent.set(p.parentPostId, arr);
      }
    });
    byParent.forEach((arr) => arr.sort(sortByTime));

    function appendFlat(parentId: string | null, depth: number) {
      const children = byParent.get(parentId) || [];
      children.forEach((p) => {
        if (!pushOnce(p, depth)) return;
        appendFlat(p.postId ?? "", depth + 1);
      });
    }
    const roots = (byParent.get(null) || []).slice().sort(sortByTimeDesc);
    roots.forEach((p) => {
      if (!pushOnce(p, 0)) return;
      appendFlat(p.postId ?? "", 1);
    });
    return result;
  }

  if (hasNestedReplies) {
    // Nested structure: same post can appear in multiple parents' replies — output each postId once
    function append(post: ForumPost, depth: number) {
      if (!pushOnce(post, depth)) return;
      const replies = (post.replies || []).filter((r) => r).slice();
      replies.sort(sortByTime);
      replies.forEach((r) => append(r, depth + 1));
    }
    topLevel.sort(sortByTimeDesc);
    topLevel.forEach((p) => append(p, 0));
    return result;
  }

  // Fallback: no parentPostId and no nested replies — infer replies from @mention at start of content
  const sorted = list.slice().sort(sortByTime);
  const authorToLastPost = new Map<string, ForumPost>();
  const inferredParentId = new Map<string, string>();
  for (const p of sorted) {
    const mention = getReplyMention(p.content);
    const pid = p.postId ?? "";
    if (mention) {
      const parent = authorToLastPost.get(mention);
      if (parent && parent.postId) inferredParentId.set(pid, parent.postId);
    }
    if (p.author) authorToLastPost.set(p.author, p);
  }

  const byParent = new Map<string | null, ForumPost[]>();
  sorted.forEach((p) => {
    const parentId =
      p.parentPostId ?? inferredParentId.get(p.postId ?? "") ?? null;
    const arr = byParent.get(parentId) || [];
    arr.push(p);
    byParent.set(parentId, arr);
  });
  byParent.forEach((arr) => arr.sort(sortByTime));

  function appendFlat(parentId: string | null, depth: number) {
    const children = byParent.get(parentId) || [];
    children.forEach((p) => {
      if (!pushOnce(p, depth)) return;
      appendFlat(p.postId ?? "", depth + 1);
    });
  }
  const roots = (byParent.get(null) || []).slice().sort(sortByTimeDesc);
  roots.forEach((p) => {
    if (!pushOnce(p, 0)) return;
    appendFlat(p.postId ?? "", 1);
  });
  return result;
}

const ForumPreview: React.FC<ForumPreviewProps> = ({
  initialLimit = 5,
  userId,
  userEmail,
  forumId: propForumId,
}) => {
  const [forumData, setForumData] = useState<ForumPostsResponse | null>(null);
  const [posts, setPosts] = useState<ForumPost[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  // Game filter state
  const [availableGames, setAvailableGames] = useState<Game[]>([]);
  const [selectedGame, setSelectedGame] = useState<string | null>(null); // null = all games
  const [loadingGames, setLoadingGames] = useState(true);

  // Reply state
  const [replyingToPostId, setReplyingToPostId] = useState<string | null>(null);
  const [replyContent, setReplyContent] = useState<string>("");
  const [postingReply, setPostingReply] = useState(false);

  // Post management state
  const [postStatus, setPostStatus] = useState<PostStatusResponse | null>(null);
  const [checkingStatus, setCheckingStatus] = useState(false);
  const [postContent, setPostContent] = useState("");
  const [isEditing, setIsEditing] = useState(false);
  const [posting, setPosting] = useState(false);
  const [showAuthPrompt, setShowAuthPrompt] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [likingPostId, setLikingPostId] = useState<string | null>(null);
  const [moderationWarning, setModerationWarning] = useState<string | null>(
    null
  );
  const [detectedWords, setDetectedWords] = useState<string[]>([]);

  // Image upload state
  const [selectedImage, setSelectedImage] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [uploadedImageUrl, setUploadedImageUrl] = useState<string | null>(null);
  const [uploadedImagePublicId, setUploadedImagePublicId] = useState<
    string | null
  >(null);
  const [uploadingImage, setUploadingImage] = useState(false);
  const [imageModerationWarning, setImageModerationWarning] = useState<
    string | null
  >(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Format timestamp to readable date
  const formatDate = (timestamp: string): string => {
    try {
      const date = new Date(timestamp);
      return date.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
    } catch {
      return "Unknown date";
    }
  };

  // Handle image file selection
  const handleImageSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Validate file type
    if (!file.type.startsWith("image/")) {
      setErrorMessage("Please select an image file");
      setTimeout(() => setErrorMessage(null), 3000);
      return;
    }

    // Validate file size (e.g., 5MB max)
    if (file.size > 5 * 1024 * 1024) {
      setErrorMessage("Image size must be less than 5MB");
      setTimeout(() => setErrorMessage(null), 3000);
      return;
    }

    setSelectedImage(file);
    setImageModerationWarning(null);

    // Create preview
    const reader = new FileReader();
    reader.onloadend = () => {
      setImagePreview(reader.result as string);
    };
    reader.readAsDataURL(file);
  };

  // Handle button click to trigger file input
  const handleImageButtonClick = () => {
    if (fileInputRef.current && !posting && !uploadingImage) {
      fileInputRef.current.click();
    }
  };

  // Handle image upload
  const handleImageUpload = async (): Promise<{
    success: boolean;
    imageUrl?: string;
    imagePublicId?: string;
  }> => {
    if (!selectedImage || !userId) {
      // console.log("Image upload failed: missing selectedImage or userId", {
      //   selectedImage: !!selectedImage,
      //   userId: !!userId,
      // });
      return { success: false };
    }

    setUploadingImage(true);
    setImageModerationWarning(null);

    try {
      const formData = new FormData();
      formData.append("image", selectedImage);
      formData.append("userId", userId);

      // Don't include postId in image upload - let the frontend handle the PUT request separately
      // The backend's automatic update feature seems to be causing issues

      // Try the new route first, fallback to main app route if 404
      let response;
      try {
        response = await axios.post<UploadImageResponse>(
          `${API_BASE_URL}/api/public/forum-posts/upload-image`,
          formData,
          {
            headers: {
              "Content-Type": "multipart/form-data",
            },
          }
        );
      } catch (firstError: any) {
        // If 404, try the alternative route (main app route)
        if (firstError.response?.status === 404) {
          // console.log(
          //   "Route /api/public/forum-posts/upload-image not found, trying /api/uploadForumImage"
          // );
          response = await axios.post<UploadImageResponse>(
            `${API_BASE_URL}/api/uploadForumImage`,
            formData,
            {
              headers: {
                "Content-Type": "multipart/form-data",
              },
            }
          );
        } else {
          throw firstError; // Re-throw if it's not a 404
        }
      }

      // Handle multiple response formats:
      // 1. New format: { success: true, images: [{ url, name, size, type }] }
      // 2. Legacy format: { success: true, image: { url, publicId } }
      // 3. Legacy format: { success: true, imageUrl, imagePublicId }

      let imageUrl: string | undefined;
      let imagePublicId: string | undefined;

      // Type assertion to handle the response data
      const responseData = response.data as UploadImageResponse & {
        images?: Array<{ url: string; name: string; publicId?: string }>;
      };

      // Check for new format (images array)
      if (
        responseData.images &&
        Array.isArray(responseData.images) &&
        responseData.images.length > 0
      ) {
        const firstImage = responseData.images[0];
        imageUrl = firstImage.url;
        imagePublicId = firstImage.name || firstImage.publicId; // Use name as publicId fallback
        // console.log("Using new images array format:", firstImage);
      }
      // Check for legacy nested image object format
      else if (responseData.image) {
        imageUrl = responseData.image.url;
        imagePublicId = responseData.image.publicId;
        // console.log("Using legacy image object format");
      }
      // Check for legacy flat format
      else {
        imageUrl = responseData.imageUrl;
        imagePublicId = responseData.imagePublicId;
        // console.log("Using legacy flat format");
      }

      // console.log("Image upload response:", {
      //   success: responseData.success,
      //   hasImagesArray: !!responseData.images,
      //   hasImageObject: !!responseData.image,
      //   imageUrl: imageUrl,
      //   imagePublicId: imagePublicId,
      //   fullResponse: responseData,
      // });

      if (response.data.success && imageUrl) {
        // Validate the image URL format
        if (
          !imageUrl.startsWith("http://") &&
          !imageUrl.startsWith("https://")
        ) {
          console.error("Invalid image URL format:", imageUrl);
          setErrorMessage("Invalid image URL received from server");
          setTimeout(() => setErrorMessage(null), 5000);
          return { success: false };
        }

        // console.log("Setting uploaded image URL:", imageUrl);
        // console.log("Image publicId/name:", imagePublicId);

        // Use the image name as publicId if publicId is not provided
        // The backend returns name in the images array, which we can use for deletion
        // responseData is already declared above
        const finalPublicId =
          imagePublicId ||
          (responseData.images && responseData.images[0]?.name) ||
          "image";

        setUploadedImageUrl(imageUrl);
        setUploadedImagePublicId(finalPublicId);
        // Show success message
        setSuccessMessage(
          response.data.message || "Image uploaded successfully"
        );
        setTimeout(() => setSuccessMessage(null), 3000); // Auto-hide after 3 seconds
        return {
          success: true,
          imageUrl: imageUrl,
          imagePublicId: finalPublicId,
        };
      } else if (response.data.moderationWarning) {
        // Image moderation failed
        setImageModerationWarning(
          response.data.message ||
            "Image contains inappropriate content and cannot be uploaded."
        );
        // Clear selected image
        setSelectedImage(null);
        setImagePreview(null);
        return { success: false };
      } else {
        setErrorMessage(response.data.message || "Failed to upload image");
        setTimeout(() => setErrorMessage(null), 5000); // Auto-hide after 5 seconds
        return { success: false };
      }
    } catch (err: any) {
      const errorData = err.response?.data;

      // Handle 404 specifically - route not found
      if (err.response?.status === 404) {
        console.error("Image upload route not found (404):", {
          attemptedRoutes: [
            `${API_BASE_URL}/api/public/forum-posts/upload-image`,
            `${API_BASE_URL}/api/uploadForumImage`,
          ],
          error: err.message,
        });
        setErrorMessage(
          "Image upload endpoint not found. Please check that the backend server is running and the route is registered."
        );
        setTimeout(() => setErrorMessage(null), 5000);
        return { success: false };
      }

      if (errorData?.moderationWarning) {
        setImageModerationWarning(
          errorData.message ||
            "Image contains inappropriate content and cannot be uploaded."
        );
        setSelectedImage(null);
        setImagePreview(null);
      } else {
        console.error("Error uploading image:", err);
        setErrorMessage(
          errorData?.message ||
            errorData?.error ||
            `Failed to upload image: ${
              err.message || "Unknown error"
            }. Please try again.`
        );
        setTimeout(() => setErrorMessage(null), 5000); // Auto-hide after 5 seconds
      }
      return { success: false };
    } finally {
      setUploadingImage(false);
    }
  };

  // Remove selected/uploaded image
  const handleRemoveImage = () => {
    setSelectedImage(null);
    setImagePreview(null);
    setUploadedImageUrl(null);
    setUploadedImagePublicId(null);
    setImageModerationWarning(null);
  };

  // Fetch available games on mount
  useEffect(() => {
    const fetchAvailableGames = async () => {
      setLoadingGames(true);
      try {
        const response = await axios.get<GamesListResponse>(
          `${API_BASE_URL}/api/public/forum-posts/available-games`
        );

        if (response.data.success) {
          // Log backend response for debugging
          if (process.env.NODE_ENV === "development") {
            console.log("Available games response:", response.data);
          }

          // Ensure games array is safe and has required fields
          const safeGames = (response.data.games || [])
            .filter((game: any) => game && game.gameTitle)
            .map((game: any) => ({
              gameTitle: game.gameTitle || "",
              postCount: game.postCount || 0,
            }));
          setAvailableGames(safeGames);
        } else {
          // Backend returned success: false
          console.warn("Backend returned success: false for available games");
          setAvailableGames([]);
        }
      } catch (err: any) {
        // Handle errors gracefully - 500/404 are backend issues
        // Only log unexpected errors in development
        if (err?.response?.status !== 500 && err?.response?.status !== 404) {
          if (process.env.NODE_ENV === "development") {
            console.warn(
              "Error fetching available games:",
              err?.message || err,
              "Response:",
              err?.response?.data
            );
          }
        }
        // Set empty array on error so component can still render
        setAvailableGames([]);
      } finally {
        setLoadingGames(false);
      }
    };

    fetchAvailableGames();
  }, []);

  // Note: Post status check removed for unified feed - users can post without forum selection

  // Initial fetch - reload when game filter changes
  useEffect(() => {
    const fetchForumPosts = async () => {
      setLoading(true);
      setError(null);
      try {
        const params: any = {
          limit: initialLimit,
          offset: 0,
        };
        if (selectedGame) {
          params.gameTitle = selectedGame;
        }
        if (userId) {
          params.userId = userId;
        }

        const response = await axios.get<ForumPostsResponse>(
          `${API_BASE_URL}/api/public/forum-posts`,
          { params }
        );

        // Handle offline/cached response
        if (response.status === 503 && (response.data as any)?.offline) {
          // Service worker returned offline response - try direct cache check as fallback
          try {
            const RUNTIME_CACHE = "wingman-runtime-v2.0";
            const cache = await caches.open(RUNTIME_CACHE);

            // Try exact match first
            const requestUrl = `${API_BASE_URL}/api/public/forum-posts?limit=${initialLimit}&offset=0${
              selectedGame
                ? `&gameTitle=${encodeURIComponent(selectedGame)}`
                : ""
            }${userId ? `&userId=${userId}` : ""}`;
            let cachedResponse = await cache.match(requestUrl);

            // If no exact match, try matching by pathname
            if (!cachedResponse) {
              const keys = await cache.keys();
              for (const key of keys) {
                const keyUrl = new URL(key.url);
                if (keyUrl.pathname === "/api/public/forum-posts") {
                  cachedResponse = await cache.match(key);
                  if (cachedResponse) break;
                }
              }
            }

            if (cachedResponse) {
              const cachedData = await cachedResponse.json();
              if (cachedData.success) {
                // Ensure posts is always an array and each post has required fields
                const safePosts = (cachedData.posts || []).map((post: any) => ({
                  ...post,
                  gameTitle: post?.gameTitle || null,
                  categoryDisplayName: post?.categoryDisplayName || null,
                  forumTitle: post?.forumTitle || null,
                  forumId: post?.forumId || null,
                  parentPostId: post?.parentPostId || null,
                  replies: (post?.replies || []).map((reply: any) => ({
                    ...reply,
                    gameTitle: reply?.gameTitle || null,
                    categoryDisplayName: reply?.categoryDisplayName || null,
                    forumTitle: reply?.forumTitle || null,
                    forumId: reply?.forumId || null,
                    parentPostId: reply?.parentPostId || null,
                  })),
                }));
                setForumData(cachedData);
                setPosts(safePosts);
                setOffset(safePosts.length);
                setLoading(false);
                console.log(
                  "[ForumPreview] Loaded from cache after 503 response"
                );
                return;
              }
            }
          } catch (cacheErr) {
            console.error("Error checking cache directly:", cacheErr);
          }

          // No cache available for this specific request
          setError(
            "You're offline and this feed isn't cached. Please go online to load posts."
          );
          setLoading(false);
          return;
        }

        if (response.data.success) {
          // Log response structure for debugging
          if (process.env.NODE_ENV === "development") {
            console.log("Forum posts response:", {
              hasPosts: !!response.data.posts,
              postCount: response.data.posts?.length || 0,
              firstPost: response.data.posts?.[0],
            });
            // Log posts missing categoryDisplayName
            const postsWithoutCategory = (response.data.posts || []).filter(
              (post: any) => !post?.categoryDisplayName && post?.gameTitle
            );
            if (postsWithoutCategory.length > 0) {
              console.log(
                "Posts without categoryDisplayName:",
                postsWithoutCategory.map((p: any) => ({
                  gameTitle: p?.gameTitle,
                  categoryDisplayName: p?.categoryDisplayName,
                  forumTitle: p?.forumTitle,
                  category: p?.category,
                  allKeys: Object.keys(p || {}),
                }))
              );
            }
          }

          setForumData(response.data);
          // Ensure posts is always an array and each post has required fields
          const safePosts = (response.data.posts || []).map((post: any) => {
            // Preserve categoryDisplayName if it exists, even if it's an empty string
            // Also check for alternative field names
            const categoryDisplayName =
              post?.categoryDisplayName !== undefined &&
              post?.categoryDisplayName !== null
                ? String(post.categoryDisplayName).trim() || null
                : post?.category !== undefined && post?.category !== null
                ? String(post.category).trim() || null
                : null;

            return {
              ...post,
              gameTitle: post?.gameTitle || null,
              categoryDisplayName: categoryDisplayName,
              forumTitle: post?.forumTitle || null,
              forumId: post?.forumId || null,
              parentPostId: post?.parentPostId || null,
              replies: (post?.replies || []).map((reply: any) => {
                const replyCategoryDisplayName =
                  reply?.categoryDisplayName !== undefined &&
                  reply?.categoryDisplayName !== null
                    ? String(reply.categoryDisplayName).trim() || null
                    : reply?.category !== undefined && reply?.category !== null
                    ? String(reply.category).trim() || null
                    : null;

                return {
                  ...reply,
                  gameTitle: reply?.gameTitle || null,
                  categoryDisplayName: replyCategoryDisplayName,
                  forumTitle: reply?.forumTitle || null,
                  forumId: reply?.forumId || null,
                  parentPostId: reply?.parentPostId || null,
                };
              }),
            };
          });
          setPosts(safePosts);
          setOffset(safePosts.length);
        } else {
          setError("Failed to load forum posts");
        }
      } catch (err: any) {
        // Handle errors gracefully - don't log backend errors (500/404)
        const isBackendError =
          err?.response?.status === 500 || err?.response?.status === 404;
        const isNetworkError =
          !navigator.onLine ||
          err.code === "ERR_NETWORK" ||
          err.response?.status === 503;

        // Only log unexpected errors in development
        if (
          !isBackendError &&
          !isNetworkError &&
          process.env.NODE_ENV === "development"
        ) {
          console.warn("Error fetching forum posts:", err?.message || err);
        }

        // Check if offline or network error
        if (isNetworkError) {
          // Check if we got cached data despite the error
          if (err.response?.data && !err.response.data.offline) {
            // We might have cached data in the response
            try {
              const cachedData = err.response.data;
              if (cachedData.success) {
                // Ensure posts is always an array and each post has required fields
                const safePosts = (cachedData.posts || []).map((post: any) => ({
                  ...post,
                  gameTitle: post?.gameTitle || null,
                  categoryDisplayName: post?.categoryDisplayName || null,
                  forumTitle: post?.forumTitle || null,
                  forumId: post?.forumId || null,
                  parentPostId: post?.parentPostId || null,
                  replies: (post?.replies || []).map((reply: any) => ({
                    ...reply,
                    gameTitle: reply?.gameTitle || null,
                    categoryDisplayName: reply?.categoryDisplayName || null,
                    forumTitle: reply?.forumTitle || null,
                    forumId: reply?.forumId || null,
                    parentPostId: reply?.parentPostId || null,
                  })),
                }));
                setForumData(cachedData);
                setPosts(safePosts);
                setOffset(safePosts.length);
                setLoading(false);
                return;
              }
            } catch (e) {
              // Not valid cached data
            }
          }
          setError(
            "You're offline. Forum posts require an internet connection or cached data."
          );
        } else if (isBackendError) {
          // Backend error (500/404) - show user-friendly message
          setError("Unable to load forum preview. Please try again later.");
        } else {
          setError("Unable to load forum preview");
        }
      } finally {
        setLoading(false);
      }
    };

    fetchForumPosts();
  }, [initialLimit, userId, selectedGame]);

  // Load more posts (for infinite scroll)
  const loadMorePosts = useCallback(async () => {
    if (!forumData || loadingMore || !forumData.hasMore) return;

    setLoadingMore(true);
    try {
      const params: any = {
        limit: 5, // Load 5 more posts at a time
        offset: offset,
      };
      if (selectedGame) {
        params.gameTitle = selectedGame;
      }
      if (userId) {
        params.userId = userId;
      }

      const response = await axios.get<ForumPostsResponse>(
        `${API_BASE_URL}/api/public/forum-posts`,
        { params }
      );

      // Handle offline/cached response
      if (response.status === 503 && (response.data as any)?.offline) {
        // Service worker returned offline response - no cache available
        console.log("Offline: No cached posts available for load more");
        setLoadingMore(false);
        return;
      }

      if (response.data.success) {
        // Ensure posts is always an array and each post has required fields
        const newPosts = (response.data.posts || []).map((post: any) => ({
          ...post,
          gameTitle: post?.gameTitle || null,
          categoryDisplayName: post?.categoryDisplayName || null,
          forumTitle: post?.forumTitle || null,
          forumId: post?.forumId || null,
          parentPostId: post?.parentPostId || null,
          replies: (post?.replies || []).map((reply: any) => ({
            ...reply,
            gameTitle: reply?.gameTitle || null,
            categoryDisplayName: reply?.categoryDisplayName || null,
            forumTitle: reply?.forumTitle || null,
            forumId: reply?.forumId || null,
            parentPostId: reply?.parentPostId || null,
          })),
        }));
        setPosts((prev) => [...prev, ...newPosts]);
        setForumData((prev) =>
          prev ? { ...prev, hasMore: response.data.hasMore } : response.data
        );
        setOffset((prev) => prev + newPosts.length);
      }
    } catch (err: any) {
      // Handle errors gracefully - don't log backend errors (500/404)
      const isBackendError =
        err?.response?.status === 500 || err?.response?.status === 404;
      const isNetworkError =
        !navigator.onLine ||
        err.code === "ERR_NETWORK" ||
        err.response?.status === 503;

      // Only log unexpected errors in development
      if (
        !isBackendError &&
        !isNetworkError &&
        process.env.NODE_ENV === "development"
      ) {
        console.warn("Error loading more posts:", err?.message || err);
      }

      // Handle offline scenarios gracefully
      if (isNetworkError) {
        // Check if it's an offline response with cached data
        if (err.response?.data?.offline) {
          console.log("Offline: No cached posts available for load more");
        } else {
          console.log("Offline: Cannot load more posts");
        }
        // Don't show error to user - just silently fail
      }
    } finally {
      setLoadingMore(false);
    }
  }, [forumData, loadingMore, offset, userId, selectedGame]);

  // Infinite scroll handler
  useEffect(() => {
    const handleScroll = () => {
      // Check if we're near the bottom of the page
      const scrollTop = window.scrollY || document.documentElement.scrollTop;
      const windowHeight = window.innerHeight;
      const documentHeight = document.documentElement.scrollHeight;

      // Trigger when user is within 300px of the bottom
      const threshold = 300;

      if (
        documentHeight - (scrollTop + windowHeight) < threshold &&
        forumData?.hasMore &&
        !loadingMore
      ) {
        loadMorePosts();
      }
    };

    // Throttle scroll events for better performance
    let ticking = false;
    const throttledHandleScroll = () => {
      if (!ticking) {
        window.requestAnimationFrame(() => {
          handleScroll();
          ticking = false;
        });
        ticking = true;
      }
    };

    window.addEventListener("scroll", throttledHandleScroll);
    return () => {
      window.removeEventListener("scroll", throttledHandleScroll);
    };
  }, [forumData?.hasMore, loadingMore, loadMorePosts]);

  // Refresh posts after creating/editing/deleting
  const refreshPosts = async () => {
    try {
      const params: any = {
        limit: initialLimit,
        offset: 0,
      };
      if (selectedGame) {
        params.gameTitle = selectedGame;
      }
      if (userId) {
        params.userId = userId;
      }

      const response = await axios.get<ForumPostsResponse>(
        `${API_BASE_URL}/api/public/forum-posts`,
        { params }
      );

      // Handle offline/cached response
      if (response.status === 503 && (response.data as any)?.offline) {
        // Service worker returned offline response - can't refresh
        console.log("Offline: Cannot refresh posts");
        return;
      }

      if (response.data.success) {
        // Ensure posts is always an array and each post has required fields
        const safePosts = (response.data.posts || []).map((post: any) => ({
          ...post,
          gameTitle: post?.gameTitle || null,
          forumTitle: post?.forumTitle || null,
          forumId: post?.forumId || null,
          parentPostId: post?.parentPostId || null,
          replies: (post?.replies || []).map((reply: any) => ({
            ...reply,
            gameTitle: reply?.gameTitle || null,
            forumTitle: reply?.forumTitle || null,
            forumId: reply?.forumId || null,
            parentPostId: reply?.parentPostId || null,
          })),
        }));
        setForumData(response.data);
        setPosts(safePosts);
        setOffset(safePosts.length);
      }
    } catch (err: any) {
      // Handle errors gracefully - don't log backend errors (500/404)
      const isBackendError =
        err?.response?.status === 500 || err?.response?.status === 404;
      const isNetworkError =
        !navigator.onLine ||
        err.code === "ERR_NETWORK" ||
        err.response?.status === 503;

      // Only log unexpected errors in development
      if (
        !isBackendError &&
        !isNetworkError &&
        process.env.NODE_ENV === "development"
      ) {
        console.warn("Error refreshing posts:", err?.message || err);
      }

      // Silently fail when offline or backend error - don't show error
      if (isNetworkError) {
        console.log("Offline: Cannot refresh posts");
      }
      // Backend errors (500/404) are silently handled - no user notification needed
    }
  };

  // Handle like/unlike post
  const handleLikePost = async (postId: string, currentlyLiked: boolean) => {
    if (!userId || !postId) return;

    setLikingPostId(postId);
    try {
      const response = await apiClient.post<LikePostResponse>(
        `/api/public/forum-posts/${postId}/like`,
        { userId }
      );

      // Handle queued response
      if (response.status === 202 || (response.data as any)?.queued) {
        // Request was queued - show optimistic update
        setPosts((prevPosts) =>
          prevPosts.map((post) =>
            post.postId === postId
              ? {
                  ...post,
                  isLiked: !currentlyLiked,
                  likes: currentlyLiked ? post.likes - 1 : post.likes + 1,
                }
              : post
          )
        );
        return;
      }

      if (response.data.success) {
        // Update the post in the posts array
        setPosts((prevPosts) =>
          prevPosts.map((post) =>
            post.postId === postId
              ? {
                  ...post,
                  isLiked: response.data.liked,
                  likes: response.data.likes,
                }
              : post
          )
        );
      }
    } catch (err: any) {
      console.error("Error liking post:", err);

      // If offline and request was queued, show success message instead of error
      if (
        err.code === "OFFLINE_QUEUED" ||
        err.response?.status === 202 ||
        (err.response?.data as any)?.queued
      ) {
        // Request was queued - show optimistic update
        setPosts((prevPosts) =>
          prevPosts.map((post) =>
            post.postId === postId
              ? {
                  ...post,
                  isLiked: !currentlyLiked,
                  likes: currentlyLiked ? post.likes - 1 : post.likes + 1,
                }
              : post
          )
        );
        return;
      }

      alert(
        err.response?.data?.message || "Failed to like post. Please try again."
      );
    } finally {
      setLikingPostId(null);
    }
  };

  // Create or update post
  const handleSubmitPost = async (e: React.FormEvent) => {
    e.preventDefault();

    // Check auth - if no userId, show login prompt
    if (!userId) {
      setShowAuthPrompt(true);
      return;
    }

    // Validate: must have either content or image (or both)
    const hasContent = postContent.trim().length > 0;
    const hasImage = uploadedImageUrl && uploadedImagePublicId;
    const hasNewImage = selectedImage && !uploadedImageUrl;

    if (!hasContent && !hasImage && !hasNewImage) {
      setErrorMessage("Please add a message or upload an image");
      setTimeout(() => setErrorMessage(null), 3000);
      return;
    }

    // Clear any previous moderation warnings
    setModerationWarning(null);
    setDetectedWords([]);
    setImageModerationWarning(null);

    setPosting(true);
    try {
      // Track if post had an image before editing
      const hadImageBefore =
        isEditing &&
        postStatus?.post?.attachments &&
        postStatus.post.attachments.length > 0;

      // If there's a new image selected, upload it first
      let finalImageUrl = uploadedImageUrl;
      let finalImagePublicId = uploadedImagePublicId;

      // Always upload if a new image file is selected (even if there's an existing image)
      if (selectedImage) {
        // console.log("New image selected, uploading...");
        // console.log(
        //   "Current state - isEditing:",
        //   isEditing,
        //   "postId:",
        //   postStatus?.postId
        // );
        const uploadResult = await handleImageUpload();
        // console.log("Upload result:", uploadResult);
        if (
          !uploadResult.success ||
          !uploadResult.imageUrl ||
          !uploadResult.imagePublicId
        ) {
          console.error("Image upload failed, aborting post update");
          setPosting(false);
          return; // Image upload failed or was moderated
        }
        // console.log("Image uploaded successfully:", uploadResult.imageUrl);
        finalImageUrl = uploadResult.imageUrl;
        finalImagePublicId = uploadResult.imagePublicId;
        // Also update state immediately
        setUploadedImageUrl(uploadResult.imageUrl);
        setUploadedImagePublicId(uploadResult.imagePublicId);
      } else {
        // console.log("No new image selected. Using existing:", finalImageUrl);
      }

      // console.log(
      //   "About to check if editing. isEditing:",
      //   isEditing,
      //   "postId:",
      //   postStatus?.postId
      // );
      // console.log(
      //   "Final image URL:",
      //   finalImageUrl,
      //   "Final image PublicId:",
      //   finalImagePublicId
      // );

      if (isEditing && postStatus?.postId) {
        // console.log("Proceeding with PUT request to update post");
        // console.log(
        //   "PUT URL will be:",
        //   `${API_BASE_URL}/api/public/forum-posts/${postStatus.postId}`
        // );
        // Update existing post
        const updateData: any = {
          userId,
        };

        // Always include content (even if empty, backend might need it)
        if (postContent.trim()) {
          updateData.content = postContent.trim();
        }

        // Handle image changes - use attachments array format (like main app)
        if (finalImageUrl && finalImagePublicId) {
          // Image is present (either new upload or existing)
          // Validate URL before sending
          if (
            !finalImageUrl.startsWith("http://") &&
            !finalImageUrl.startsWith("https://")
          ) {
            console.error("Invalid image URL in update data:", finalImageUrl);
            setErrorMessage(
              "Invalid image URL. Please try uploading the image again."
            );
            setTimeout(() => setErrorMessage(null), 5000);
            setPosting(false);
            setIsEditing(false);
            return;
          }
          // Use attachments array format (like main app) - this is more reliable
          updateData.attachments = [
            {
              type: "image",
              url: finalImageUrl,
              name: finalImagePublicId || "image",
              publicId: finalImagePublicId, // Include publicId for deletion
            },
          ];
          // console.log("Including image in update (attachments format):", {
          //   attachments: updateData.attachments,
          //   imageUrl: finalImageUrl,
          //   imagePublicId: finalImagePublicId,
          //   urlPreview: finalImageUrl.substring(0, 80) + "...",
          //   fullUrl: finalImageUrl, // Log full URL for debugging
          //   urlIsImageKit: finalImageUrl.includes("ik.imagekit.io"),
          // });

          // Warn if URL doesn't look like a valid ImageKit URL
          if (
            !finalImageUrl.includes("ik.imagekit.io") &&
            !finalImageUrl.includes("imagekit")
          ) {
            console.warn(
              "Image URL doesn't appear to be from ImageKit:",
              finalImageUrl
            );
          }
        } else if (hadImageBefore && !finalImageUrl && !finalImagePublicId) {
          // Post had image before but now it's removed (user clicked remove)
          updateData.removeImage = true;
          // console.log("Removing image from post");
        } else {
          // console.log("No image changes - keeping existing or no image");
        }

        // Always ensure we have content or image (backend requirement)
        if (
          !updateData.content &&
          !updateData.attachments &&
          !updateData.removeImage
        ) {
          // This shouldn't happen due to validation, but just in case
          console.warn("Update request has neither content nor image");
        }

        // console.log("Updating post with data:", updateData);
        // console.log("Post ID:", postStatus.postId);
        // console.log("Post ID type:", typeof postStatus.postId);
        // console.log("Post ID length:", postStatus.postId?.length);

        // Validate postId before making request
        if (
          !postStatus.postId ||
          typeof postStatus.postId !== "string" ||
          postStatus.postId.trim().length === 0
        ) {
          console.error("Invalid postId:", postStatus.postId);
          setErrorMessage(
            "Invalid post ID. Please refresh the page and try again."
          );
          setTimeout(() => setErrorMessage(null), 5000);
          setPosting(false);
          setIsEditing(false);
          return;
        }

        // Ensure postId is a valid MongoDB ObjectId format (24 hex characters)
        const postIdPattern = /^[0-9a-fA-F]{24}$/;
        if (!postIdPattern.test(postStatus.postId)) {
          console.error(
            "PostId is not a valid MongoDB ObjectId:",
            postStatus.postId
          );
          setErrorMessage(
            "Invalid post ID format. Please refresh the page and try again."
          );
          setTimeout(() => setErrorMessage(null), 5000);
          setPosting(false);
          setIsEditing(false);
          return;
        }

        try {
          const putUrl = `${API_BASE_URL}/api/public/forum-posts/${postStatus.postId}`;
          // console.log("Sending PUT request to:", putUrl);
          // console.log(
          //   "PUT request payload:",
          //   JSON.stringify(updateData, null, 2)
          // );

          // Note: forumId no longer needed for unified feed

          const response = await apiClient.put<UpdatePostResponse>(
            `/api/public/forum-posts/${postStatus.postId}`,
            updateData
          );

          // Handle queued response
          if (response.status === 202 || (response.data as any)?.queued) {
            setSuccessMessage(
              "Post update queued. It will be saved when you're back online."
            );
            setTimeout(() => setSuccessMessage(null), 5000);
            setIsEditing(false);
            setPosting(false);
            return;
          }

          // console.log("Update response:", response.data);

          if (response.data.success) {
            // Show success message
            setSuccessMessage("Post updated successfully");
            setTimeout(() => setSuccessMessage(null), 3000);

            // Close edit mode immediately - do this first
            setIsEditing(false);

            // Clear temporary image state
            setSelectedImage(null);
            setImagePreview(null);

            // Refresh posts list
            await refreshPosts();
          } else {
            // Update failed - show error but still close edit mode
            console.error("Update failed:", response.data);
            setErrorMessage(response.data.message || "Failed to update post");
            setTimeout(() => setErrorMessage(null), 5000);
            setIsEditing(false);
          }
        } catch (updateError: any) {
          console.error("Error updating post:", updateError);
          console.error("Error response:", updateError.response?.data);
          console.error("Error status:", updateError.response?.status);
          console.error("Error message:", updateError.message);

          // Check if it's a network error or server error
          const errorMessage =
            updateError.response?.data?.message ||
            updateError.response?.data?.error ||
            updateError.message ||
            "Failed to update post. Please try again.";

          // If the image was uploaded successfully but the update failed,
          // the image is still in ImageKit, so we should still close the edit UI
          // and let the user know they may need to refresh
          if (finalImageUrl && finalImagePublicId) {
            console.warn(
              "Image was uploaded but post update failed. Image URL:",
              finalImageUrl
            );
            setErrorMessage(
              `${errorMessage} The image was uploaded successfully. Please refresh the page to see it.`
            );
          } else {
            setErrorMessage(errorMessage);
          }

          setTimeout(() => setErrorMessage(null), 5000);
          setIsEditing(false);
        }
      } else {
        // Create new post
        try {
          const createData: any = {
            userId,
            content: postContent.trim() || undefined,
          };

          // Use attachments array format (like main app) - this is more reliable
          if (finalImageUrl && finalImagePublicId) {
            // Validate URL before sending
            if (
              !finalImageUrl.startsWith("http://") &&
              !finalImageUrl.startsWith("https://")
            ) {
              console.error("Invalid image URL in create data:", finalImageUrl);
              setErrorMessage(
                "Invalid image URL. Please try uploading the image again."
              );
              setTimeout(() => setErrorMessage(null), 5000);
              setPosting(false);
              return;
            }
            createData.attachments = [
              {
                type: "image",
                url: finalImageUrl,
                name: finalImagePublicId || "image",
                publicId: finalImagePublicId, // Include publicId for deletion
              },
            ];
            // console.log("Including image in create (attachments format):", {
            //   attachments: createData.attachments,
            //   imageUrl: finalImageUrl,
            //   imagePublicId: finalImagePublicId,
            // });
          }

          // Note: forumId no longer needed for unified feed

          const response = await apiClient.post<CreatePostResponse>(
            `/api/public/forum-posts`,
            createData
          );

          // Handle queued response
          if (response.status === 202 || (response.data as any)?.queued) {
            setPostContent("");
            setSelectedImage(null);
            setImagePreview(null);
            setUploadedImageUrl(null);
            setUploadedImagePublicId(null);
            setSuccessMessage(
              "Post queued. It will be published when you're back online."
            );
            setTimeout(() => setSuccessMessage(null), 5000);
            setPosting(false);
            return;
          }

          if (response.data.success) {
            setPostContent("");
            // Clear image state
            setSelectedImage(null);
            setImagePreview(null);
            setUploadedImageUrl(null);
            setUploadedImagePublicId(null);
            await refreshPosts();
            // Clear form after successful post
            setPostContent("");
            setSelectedImage(null);
            setImagePreview(null);
            setUploadedImageUrl(null);
            setUploadedImagePublicId(null);
          }
        } catch (createError: any) {
          console.error("Error creating post:", createError);
          const errorData = createError.response?.data;

          // Check if auth is required
          if (createError.response?.status === 401 && errorData?.requiresAuth) {
            setShowAuthPrompt(true);
            return;
          }

          setErrorMessage(
            errorData?.message || "Failed to create post. Please try again."
          );
          setTimeout(() => setErrorMessage(null), 5000);
        }
      }
    } catch (err: any) {
      // Check if this is a content moderation error
      const errorData = err.response?.data;

      console.error("Error in handleSubmitPost:", err);
      console.error("Error response data:", errorData);

      if (errorData?.moderationWarning === true) {
        // This is expected - content moderation blocked the post
        // Show user-friendly message, don't throw or show alert
        const moderationError = errorData as ModerationErrorResponse;
        setModerationWarning(
          moderationError.message ||
            "Your post contains inappropriate or offensive content. Please remove any offensive or inappropriate words and try again."
        );
        if (
          moderationError.detectedWords &&
          moderationError.detectedWords.length > 0
        ) {
          setDetectedWords(moderationError.detectedWords);
          console.error(
            "Content moderation blocked post:",
            moderationError.detectedWords
          );
        } else {
          console.error("Content moderation blocked post");
        }
        // Don't throw, just return - this is expected validation behavior
        // But still close edit mode if we're editing
        if (isEditing) {
          setIsEditing(false);
        }
        return;
      }

      // For other errors, handle appropriately
      console.error("Error submitting post:", err);
      setErrorMessage(
        errorData?.message || "Failed to submit post. Please try again."
      );
      setTimeout(() => setErrorMessage(null), 5000);
      // Always close edit mode on error so user isn't stuck
      if (isEditing) {
        setIsEditing(false);
      }
    } finally {
      setPosting(false);
    }
  };

  // Delete post
  const handleDeletePost = async () => {
    if (!userId || !postStatus?.postId) return;
    setShowDeleteModal(true);
  };

  // Confirm delete post
  const handleConfirmDelete = async () => {
    if (!userId || !postStatus?.postId) return;

    setShowDeleteModal(false);
    setDeleting(true);
    try {
      const response = await apiClient.delete<DeletePostResponse>(
        `/api/public/forum-posts/${postStatus.postId}`,
        {
          params: { userId },
        }
      );

      // Handle queued response
      if (response.status === 202 || (response.data as any)?.queued) {
        setPostContent("");
        setIsEditing(false);
        setSuccessMessage(
          "Post deletion queued. It will be deleted when you're back online."
        );
        setTimeout(() => setSuccessMessage(null), 5000);
        setDeleting(false);
        return;
      }

      if (response.data.success) {
        setPostContent("");
        setIsEditing(false);
        await refreshPosts();
      }
    } catch (err: any) {
      console.error("Error deleting post:", err);
      alert(
        err.response?.data?.message ||
          "Failed to delete post. Please try again."
      );
    } finally {
      setDeleting(false);
    }
  };

  // Cancel delete
  const handleCancelDelete = () => {
    setShowDeleteModal(false);
  };

  // Start editing
  const handleStartEdit = () => {
    if (postStatus?.post?.content) {
      setPostContent(postStatus.post.content);
      setIsEditing(true);
    }
  };

  // Cancel editing
  const handleCancelEdit = () => {
    if (postStatus?.post?.content) {
      setPostContent(postStatus.post.content);
    } else {
      setPostContent("");
    }
    setIsEditing(false);
    // Clear any moderation warnings when canceling
    setModerationWarning(null);
    setDetectedWords([]);
    // Reset image state to existing image
    if (
      postStatus?.post?.attachments &&
      postStatus.post.attachments.length > 0
    ) {
      const firstAttachment = postStatus.post.attachments[0];
      const imageUrl = getAttachmentUrl(firstAttachment);
      if (imageUrl) {
        setUploadedImageUrl(imageUrl);
      }
    } else {
      setSelectedImage(null);
      setImagePreview(null);
      setUploadedImageUrl(null);
      setUploadedImagePublicId(null);
    }
  };

  // Handle reply submission
  const handleSubmitReply = async (postId: string) => {
    if (!replyContent.trim()) return;

    // Check auth
    if (!userId) {
      setShowAuthPrompt(true);
      return;
    }

    setPostingReply(true);
    try {
      const response = await apiClient.post<ReplyResponse>(
        `/api/public/forum-posts/${postId}/reply`,
        {
          userId,
          content: replyContent.trim(),
        }
      );

      // Check if auth is required
      if (response.status === 401 || response.data.requiresAuth) {
        setShowAuthPrompt(true);
        setPostingReply(false);
        return;
      }

      if (response.data.success) {
        setReplyContent("");
        setReplyingToPostId(null);
        await refreshPosts();
      }
    } catch (err: any) {
      const errorData = err.response?.data;

      // Check if auth is required
      if (err.response?.status === 401 && errorData?.requiresAuth) {
        setShowAuthPrompt(true);
      } else {
        setErrorMessage(
          errorData?.message || "Failed to post reply. Please try again."
        );
        setTimeout(() => setErrorMessage(null), 5000);
      }
    } finally {
      setPostingReply(false);
    }
  };

  // Start replying to a post
  const handleStartReply = (postId: string) => {
    setReplyingToPostId(postId);
    setReplyContent("");
  };

  // Cancel reply
  const handleCancelReply = () => {
    setReplyingToPostId(null);
    setReplyContent("");
  };

  // Use consistent loading text constant to prevent hydration mismatch
  const LOADING_TEXT = "Loading community preview...";

  // Early returns with consistent text to prevent hydration mismatch
  if (loadingGames || loading) {
    return (
      <div className="preview-section forum-preview">
        <div className="loading-spinner"></div>
        <p className="preview-loading-text">{LOADING_TEXT}</p>
      </div>
    );
  }

  if (error || !forumData) {
    return (
      <div className="preview-section forum-preview">
        <p className="preview-error">{error || "Unable to load preview"}</p>
        {typeof window !== "undefined" && !navigator.onLine && (
          <p
            className="preview-error"
            style={{ fontSize: "0.9rem", marginTop: "8px", opacity: 0.8 }}
          >
            💡 Tip: Load posts while online to view them offline later.
          </p>
        )}
      </div>
    );
  }

  // Ensure posts is always an array before rendering
  if (!Array.isArray(posts)) {
    return (
      <div className="preview-section forum-preview">
        <p className="preview-error">Invalid data format</p>
      </div>
    );
  }

  // Ensure posts is always an array before rendering
  if (!Array.isArray(posts)) {
    return (
      <div className="preview-section forum-preview">
        <p className="preview-error">Invalid data format</p>
      </div>
    );
  }

  return (
    <div className="preview-section forum-preview">
      {/* Success/Error Toast Messages */}
      {successMessage && (
        <div className="toast-message toast-success">
          <span className="toast-icon">✓</span>
          <span className="toast-text">{successMessage}</span>
          <button
            className="toast-close"
            onClick={() => setSuccessMessage(null)}
            aria-label="Close"
          >
            ✕
          </button>
        </div>
      )}
      {errorMessage && (
        <div className="toast-message toast-error">
          <span className="toast-icon">⚠</span>
          <span className="toast-text">{errorMessage}</span>
          <button
            className="toast-close"
            onClick={() => setErrorMessage(null)}
            aria-label="Close"
          >
            ✕
          </button>
        </div>
      )}
      {/* Delete Confirmation Modal */}
      {showDeleteModal && (
        <div className="modal-overlay" onClick={handleCancelDelete}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <h3 className="modal-title">Delete Post</h3>
            <p className="modal-message">
              Are you sure you want to delete your post?
            </p>
            <div className="modal-actions">
              <button
                className="modal-button modal-button-cancel"
                onClick={handleCancelDelete}
                disabled={deleting}
              >
                Cancel
              </button>
              <button
                className="modal-button modal-button-confirm"
                onClick={handleConfirmDelete}
                disabled={deleting}
              >
                {deleting ? "Deleting..." : "Delete"}
              </button>
            </div>
          </div>
        </div>
      )}
      <div className="preview-header">
        <h2 className="preview-title">Join Our Gaming Community</h2>
        <p className="preview-subtitle">
          See what gamers are discussing across all games
        </p>
        {/* Game Filter */}
        {Array.isArray(availableGames) && availableGames.length > 0 && (
          <div className="forum-selector-container">
            <label htmlFor="game-filter" className="forum-selector-label">
              Filter by Game:
            </label>
            <select
              id="game-filter"
              className="forum-selector"
              value={selectedGame || ""}
              onChange={(e) => {
                const newGame = e.target.value || null;
                setSelectedGame(newGame);
                // Reset posts and offset when switching games
                setPosts([]);
                setOffset(0);
                setForumData(null);
              }}
              disabled={loading || loadingGames}
            >
              <option value="">All Games</option>
              {availableGames
                .filter(
                  (game) => game && typeof game === "object" && game?.gameTitle
                )
                .map((game) => {
                  if (!game || typeof game !== "object") return null;
                  const gameTitle = game?.gameTitle || "";
                  const postCount = game?.postCount || 0;
                  if (!gameTitle || typeof gameTitle !== "string") return null;
                  return (
                    <option key={gameTitle} value={gameTitle}>
                      {gameTitle} ({postCount} posts)
                    </option>
                  );
                })
                .filter(Boolean)}
            </select>
          </div>
        )}
      </div>

      {/* Comment Box - Above first post, visible to all */}
      <div className="comment-box-container" style={{ marginBottom: "20px" }}>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            handleSubmitPost(e);
          }}
          className="post-form create-post-form"
        >
          <textarea
            className="post-textarea create-textarea"
            value={postContent}
            onChange={(e) => {
              setPostContent(e.target.value);
              if (moderationWarning) {
                setModerationWarning(null);
                setDetectedWords([]);
              }
            }}
            placeholder="Add your comment here..."
            rows={4}
            disabled={posting}
          />
          <button
            type="submit"
            className="post-submit-button"
            disabled={posting || !postContent.trim()}
          >
            {posting ? "Posting..." : "Send"}
          </button>
        </form>
      </div>

      {/* Auth Prompt Modal */}
      {showAuthPrompt && (
        <div className="modal-overlay" onClick={() => setShowAuthPrompt(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <h3 className="modal-title">Login Required</h3>
            <p className="modal-message">
              Please login or sign up to post comments and replies.
            </p>
            <div className="modal-actions">
              <button
                className="modal-button modal-button-confirm"
                onClick={() => setShowAuthPrompt(false)}
              >
                OK
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="forum-posts-container" ref={scrollContainerRef}>
        {Array.isArray(posts) && posts.length > 0 ? (
          buildThreadOrder(posts).map(({ post, depth }, index) => {
            // Strict null checks - ensure post is a valid object
            if (!post || typeof post !== "object") return null;
            // Safe access to all post properties with strict type checks
            const gameTitle =
              post && typeof post === "object" && "gameTitle" in post
                ? typeof post.gameTitle === "string"
                  ? post.gameTitle
                  : null
                : null;
            // Try categoryDisplayName first, fallback to forumTitle if not available
            const categoryDisplayName =
              post && typeof post === "object" && "categoryDisplayName" in post
                ? typeof post.categoryDisplayName === "string" &&
                  post.categoryDisplayName.trim()
                  ? post.categoryDisplayName.trim()
                  : null
                : null;
            const forumTitle =
              post && typeof post === "object" && "forumTitle" in post
                ? typeof post.forumTitle === "string"
                  ? post.forumTitle
                  : null
                : null;

            // Clean category name by removing redundant game title prefix
            const cleanCategoryName = (
              category: string | null,
              game: string | null
            ): string | null => {
              if (!category || !game) return category;

              // Remove game title prefix if it exists (handles "Game Title - Category" or "Game Title -Category")
              const prefixPattern = new RegExp(
                `^${game.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*-\\s*`,
                "i"
              );
              const cleaned = category.replace(prefixPattern, "").trim();

              // Return cleaned category if it's different, otherwise return original
              return cleaned && cleaned !== category ? cleaned : category;
            };

            // Fallback: use forumTitle if categoryDisplayName is not available
            const categoryName = cleanCategoryName(
              categoryDisplayName ||
                (forumTitle &&
                typeof forumTitle === "string" &&
                forumTitle.trim()
                  ? forumTitle.trim()
                  : null),
              gameTitle
            );
            const forumId =
              post && typeof post === "object" && "forumId" in post
                ? typeof post.forumId === "string"
                  ? post.forumId
                  : null
                : null;

            // Ensure we have required fields before rendering
            if (!post.author || !post.content || !post.timestamp) {
              if (process.env.NODE_ENV === "development") {
                console.warn("Post missing required fields:", post);
              }
              return null;
            }

            const isReply = depth > 0;
            const indentPx = depth * THREAD_INDENT_PX;

            return (
              <div
                key={post.postId ? `post-${post.postId}` : `post-${index}`}
                className={
                  isReply
                    ? "reply-post forum-post-preview"
                    : "forum-post-preview"
                }
                style={{
                  marginLeft: indentPx,
                  marginBottom: "10px",
                  ...(isReply
                    ? {
                        paddingLeft: "15px",
                        borderLeft: "2px solid rgba(224, 224, 224, 0.4)",
                        padding: "10px",
                        backgroundColor: "rgba(255, 255, 255, 0.04)",
                        borderRadius: "4px",
                      }
                    : {}),
                }}
              >
                {/* Game title badge */}
                {gameTitle && typeof gameTitle === "string" && (
                  <div
                    className="post-game-badge"
                    style={{
                      display: "inline-block",
                      padding: "4px 8px",
                      backgroundColor: "#f0f0f0",
                      borderRadius: "4px",
                      fontSize: "0.85rem",
                      marginBottom: "8px",
                      color: "#e94560",
                      fontWeight: 600,
                    }}
                  >
                    {categoryName
                      ? `${gameTitle} (${categoryName})`
                      : gameTitle}
                  </div>
                )}
                <div className="post-header">
                  <span className="post-author">
                    {isReply ? "Reply by " : "Posted by "}
                    {post.author}
                  </span>
                  <span
                    className="post-date"
                    style={
                      isReply
                        ? { color: "rgba(255, 255, 255, 0.85)" }
                        : undefined
                    }
                  >
                    on {formatDate(post.timestamp)}
                    {post.edited && post.editedAt && (
                      <span className="post-edited">
                        {" "}
                        (edited on {formatDate(post.editedAt)})
                      </span>
                    )}
                  </span>
                </div>
                <div className="post-content">{post.content}</div>
                {post.attachments && post.attachments.length > 0 && (
                  <div className="post-attachments">
                    {post.attachments.map((attachment, imgIndex) => {
                      const imageUrl = getAttachmentUrl(attachment);
                      if (!imageUrl) return null;
                      return (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          key={imgIndex}
                          src={imageUrl}
                          alt={`Attachment ${imgIndex + 1}`}
                          className="post-image"
                          loading="lazy"
                          onError={(e) => {
                            e.currentTarget.style.display = "none";
                          }}
                        />
                      );
                    })}
                  </div>
                )}
                <div className="post-footer">
                  {userId && post.postId ? (
                    <button
                      className={`like-button ${post.isLiked ? "liked" : ""}`}
                      onClick={() =>
                        handleLikePost(post.postId!, post.isLiked || false)
                      }
                      disabled={likingPostId === post.postId}
                      title={
                        post.isLiked ? "Unlike this post" : "Like this post"
                      }
                    >
                      <span className="like-icon">
                        {post.isLiked ? "❤️" : "🤍"}
                      </span>
                      <span className="like-count">
                        {likingPostId === post.postId
                          ? "..."
                          : `${post.likes} ${
                              post.likes === 1 ? "Like" : "Likes"
                            }`}
                      </span>
                    </button>
                  ) : (
                    <span className="post-likes">
                      ❤️ {post.likes} {post.likes === 1 ? "Like" : "Likes"}
                    </span>
                  )}
                  {post.postId && (
                    <button
                      className="reply-button"
                      onClick={() => handleStartReply(post.postId!)}
                      style={{
                        marginLeft: "10px",
                        padding: "4px 10px",
                        backgroundColor: "rgba(233, 69, 96, 0.15)",
                        border: "1px solid #e94560",
                        borderRadius: "999px",
                        cursor: "pointer",
                        color: "#ffffff",
                        fontSize: "0.8rem",
                        fontWeight: 600,
                      }}
                    >
                      Reply
                    </button>
                  )}
                </div>

                {/* Reply input */}
                {replyingToPostId === post.postId && (
                  <div
                    className="reply-input-container"
                    style={{
                      marginLeft: "20px",
                      marginTop: "10px",
                      padding: "10px",
                      backgroundColor: "#f9f9f9",
                      borderRadius: "4px",
                      border: "1px solid #e0e0e0",
                    }}
                  >
                    <textarea
                      className="post-textarea"
                      value={replyContent}
                      onChange={(e) => setReplyContent(e.target.value)}
                      placeholder="Write your reply..."
                      rows={3}
                      disabled={postingReply}
                      style={{ width: "100%", marginBottom: "8px" }}
                    />
                    <div style={{ display: "flex", gap: "8px" }}>
                      <button
                        onClick={() => handleSubmitReply(post.postId!)}
                        disabled={postingReply || !replyContent.trim()}
                        style={{
                          padding: "6px 12px",
                          backgroundColor: "#007bff",
                          color: "white",
                          border: "none",
                          borderRadius: "4px",
                          cursor: "pointer",
                        }}
                      >
                        {postingReply ? "Posting..." : "Post Reply"}
                      </button>
                      <button
                        onClick={handleCancelReply}
                        disabled={postingReply}
                        style={{
                          padding: "6px 12px",
                          backgroundColor: "#ccc",
                          color: "black",
                          border: "none",
                          borderRadius: "4px",
                          cursor: "pointer",
                        }}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })
        ) : (
          <p
            className="preview-loading-text"
            style={{ textAlign: "center", padding: "20px" }}
          >
            No posts yet. Be the first to comment!
          </p>
        )}
      </div>

      {forumData && forumData.hasMore && (
        <div className="load-more-container">
          {loadingMore && (
            <div className="loading-more-indicator">
              <div className="loading-spinner"></div>
              <p className="loading-more-text">Loading more posts...</p>
            </div>
          )}
          {!userId && !loadingMore && (
            <p className="load-more-cta">
              Want to add your own post?{" "}
              <span className="cta-highlight">
                Sign up for early access above!
              </span>
            </p>
          )}
        </div>
      )}

      {/* Note: Post management section removed - users can post via comment box above */}

      {!userId && (
        <div className="preview-cta">
          <p className="preview-cta-text">
            <strong>Ready to join the conversation?</strong> Sign up for early
            access and become part of our gaming community!
          </p>
        </div>
      )}
    </div>
  );
};

export default ForumPreview;
