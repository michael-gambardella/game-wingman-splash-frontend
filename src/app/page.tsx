"use client";

import React, { useState, useCallback, useEffect } from "react";
import axios from "axios";
import apiClient from "../utils/apiClient";
import Image from "next/image";
import "./globals.css";
import { FormState, SignUpResponse, VerifyUserResponse } from "../../types";
import ForumPreview from "../components/ForumPreview";
import LinkedInPosts from "../components/LinkedInPosts";
import QuestionSection from "../components/QuestionSection";

const initialFormState: FormState = {
  email: "",
  message: "",
  loading: false,
  link: null,
  position: null,
  userId: null,
};

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:5000";

const SplashPage: React.FC = () => {
  const [formState, setFormState] = useState<FormState>(initialFormState);
  const [verifiedUserId, setVerifiedUserId] = useState<string | null>(null);
  const [verifiedEmail, setVerifiedEmail] = useState<string | null>(null);
  const [isApproved, setIsApproved] = useState(false);
  const [isVerifying, setIsVerifying] = useState(false);

  const handleEmailChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setFormState((prev) => ({ ...prev, email: e.target.value }));
    },
    []
  );

  // Verify user when email is entered (for existing waitlist users)
  const verifyUser = useCallback(async (email: string) => {
    setIsVerifying(true);
    try {
      const response = await axios.get<VerifyUserResponse>(
        `${API_BASE_URL}/api/public/forum-posts/verify-user`,
        {
          params: { email: email.toLowerCase().trim() },
          timeout: 25000, // 25 seconds timeout (just under Heroku's 30s limit)
        }
      );

      if (response.data.success && response.data.userId) {
        setVerifiedUserId(response.data.userId);
        setVerifiedEmail(response.data.email || email);
        if (response.data.isApproved) {
          setIsApproved(true);
        }
        return true;
      }
      return false;
    } catch (error) {
      // User not found or not on waitlist - that's okay, they can still sign up
      return false;
    } finally {
      setIsVerifying(false);
    }
  }, []);

  const handleSignUp = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();

      setFormState((prev) => ({ ...prev, loading: true, message: "" }));

      // Check if user was already on waitlist before signup attempt
      // First check if already verified in this session
      const wasAlreadyVerifiedInSession = verifiedUserId !== null;

      // Also check if user exists on waitlist (in case they weren't verified in this session)
      let wasAlreadyOnWaitlistBefore = wasAlreadyVerifiedInSession;
      if (!wasAlreadyVerifiedInSession) {
        // Quick check if user is already on waitlist
        try {
          const checkResponse = await axios.get<VerifyUserResponse>(
            `${API_BASE_URL}/api/public/forum-posts/verify-user`,
            {
              params: { email: formState.email.toLowerCase().trim() },
              timeout: 25000, // 25 seconds timeout (just under Heroku's 30s limit)
            }
          );
          if (checkResponse.data.success && checkResponse.data.userId) {
            wasAlreadyOnWaitlistBefore = true;
            setVerifiedUserId(checkResponse.data.userId);
            setVerifiedEmail(checkResponse.data.email || formState.email);
            if (checkResponse.data.isApproved) {
              setIsApproved(true);
            }
          }
        } catch (error) {
          // User not found, so this is a new signup
          wasAlreadyOnWaitlistBefore = false;
        }
      }

      try {
        const response = await apiClient.post<SignUpResponse>(
          `/api/auth/signup`,
          { email: formState.email }
        );

        // Handle queued response
        if (response.status === 202 || (response.data as any)?.queued) {
          setFormState((prev) => ({
            ...prev,
            message:
              "Signup queued. You'll be added to the waitlist when you're back online.",
            loading: false,
          }));
          return;
        }

        const userId = response.data.userId || null;

        // Customize message based on whether user was already on waitlist
        let displayMessage = response.data.message;
        if (wasAlreadyOnWaitlistBefore) {
          displayMessage =
            "Welcome back! You're already on the waitlist. " + displayMessage;
        }

        // Append email confirmation message if email was sent
        if (response.data.emailSent) {
          displayMessage +=
            "\n\n📧 Check your email for a confirmation with your waitlist position!";
        }

        setFormState((prev) => ({
          ...prev,
          message: displayMessage,
          link: response.data.link || null,
          position: response.data.position ?? null,
          userId: userId,
          loading: false,
        }));

        if (response.data.isApproved) {
          setIsApproved(true);
        }

        // If user was added to waitlist (has userId), verify them for posting
        if (userId) {
          setVerifiedUserId(userId);
          setVerifiedEmail(formState.email.toLowerCase().trim());
        } else {
          // If no userId in response, try to verify (user might already be on waitlist)
          const verified = await verifyUser(formState.email);
          if (verified) {
            // User was already on waitlist
            setFormState((prev) => ({
              ...prev,
              message: "Welcome back! You're already on the waitlist.",
            }));
          }
        }
      } catch (error) {
        console.error("Error adding email to waitlist:", error);
        // If signup fails, try to verify in case user is already on waitlist
        const verified = await verifyUser(formState.email);
        if (verified) {
          setFormState((prev) => ({
            ...prev,
            message: "Welcome back! You're already on the waitlist.",
            loading: false,
          }));
        } else {
          setFormState((prev) => ({
            ...prev,
            message: "An error occurred. Please try again.",
            loading: false,
          }));
        }
      }
    },
    [formState.email, verifyUser, verifiedUserId]
  );

  // Check if email is in URL params (for returning users)
  useEffect(() => {
    // Only run on client side to avoid hydration mismatches
    if (typeof window === "undefined") return;

    const urlParams = new URLSearchParams(window.location.search);
    const emailParam = urlParams.get("email");
    if (emailParam) {
      setFormState((prev) => ({ ...prev, email: emailParam }));
      verifyUser(emailParam);
    }
  }, [verifyUser]);

  return (
    <div className="home-container">
      <Image
        src="/video-game-wingman-logo.png"
        alt="Video Game Wingman Logo"
        width={250}
        height={250}
        priority // Adding priority for LCP optimization
        style={{ maxWidth: "100%", height: "auto" }}
      />
      <h1 style={{ textAlign: "center" }}>Stop getting stuck.</h1>
      <h1 style={{ textAlign: "center" }}>
        Start mastering every game instantly.
      </h1>
      <p className="subline">
        Your AI Co-Pilot delivers real-time tips, secrets, and pro-level
        insights while you play.
      </p>
      <form onSubmit={handleSignUp} className="auth-form">
        <input
          type="email"
          value={formState.email}
          onChange={handleEmailChange}
          placeholder="you@example.com"
          required
        />
        <button type="submit" disabled={formState.loading || isVerifying}>
          {formState.loading || isVerifying ? (
            <div className="loading-spinner"></div>
          ) : (
            "Get Early Access"
          )}
        </button>
      </form>
      <p className="early-access-note">
        The first 5,000 gamers who sign up by July 31, 2026 at 11:59 PM EDT get
        Wingman Pro free for 1 year.
      </p>
      {!verifiedUserId && (
        <p className="forum-preview-note">
          <strong>Plus:</strong> Sign up for early access to join the
          conversation and add your first post to the community below.
        </p>
      )}
      {isVerifying && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: "10px",
          }}
        >
          <div className="loading-spinner"></div>
          <p>Verifying your account...</p>
        </div>
      )}
      {formState.message && (
        <div>
          <p style={{ whiteSpace: "pre-line" }}>{formState.message}</p>
        </div>
      )}
      {(formState.link || (verifiedUserId && isApproved)) && (
        <div className="assistant-access-message">
          <p className="assistant-access-text">
            You have access! Access Video Game Wingman:
          </p>
          <a
            href={
              formState.link ||
              `https://assistant.videogamewingman.com/?earlyAccess=true&userId=${encodeURIComponent(
                formState.userId || verifiedUserId || ""
              )}`
            }
            target="_blank"
            rel="noopener noreferrer"
            className="assistant-link-button"
          >
            Go to Assistant →
          </a>
        </div>
      )}
      {formState.position !== null && (
        <p>Your waitlist position: {formState.position}</p>
      )}

      <QuestionSection userEmail={verifiedEmail || formState.email || null} />

      <div className="posts-container">
        <div className="posts-column linkedin-column">
          <LinkedInPosts />
        </div>
        <div className="posts-column forum-column">
          <ForumPreview
            initialLimit={5}
            userId={verifiedUserId}
            userEmail={verifiedEmail}
          />
        </div>
      </div>
    </div>
  );
};

export default SplashPage;
