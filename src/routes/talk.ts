import { Router, Request, Response } from 'express';
import { authenticateJWT, authorizeRoles } from '../utils/jwt';
import { evaluateContentSafety } from '../utils/ai';
import prisma from '../lib/prisma';
import { TalkStatus, ReactionType } from '../generated/prisma/enums';

const router = Router();

async function moderateBeforeCreate(_content: string): Promise<{
  status: TalkStatus;
  moderationReason: string | null;
  isCrisis: boolean;
  inputTokens: number;
  outputTokens: number;
}> {
  // TalkMindly safety check is disabled per admin instructions
  return {
    status: TalkStatus.APPROVED,
    moderationReason: null,
    isCrisis: false,
    inputTokens: 0,
    outputTokens: 0,
  };
}

// ==========================================
// 1. TalkRooms Management
// ==========================================

// GET /rooms - Fetch all active rooms
router.get('/rooms', authenticateJWT, async (req: Request, res: Response) => {
  try {
    const rooms = await prisma.talkRoom.findMany({
      where: { isActive: true },
      orderBy: { name: 'asc' },
    });
    res.status(200).json(rooms);
  } catch (err) {
    console.error('Error fetching rooms:', err);
    res.status(500).json({ error: 'Failed to fetch rooms' });
  }
});

// POST /rooms - Create a new TalkRoom (Admin only)
router.post('/rooms', authenticateJWT, authorizeRoles('ADMIN'), async (req: Request, res: Response) => {
  try {
    const { name, description } = req.body as { name?: string; description?: string };
    if (!name || name.trim().length === 0) {
      res.status(400).json({ error: 'Room name is required' });
      return;
    }

    const room = await prisma.talkRoom.create({
      data: {
        name: name.trim(),
        description: description?.trim() || null,
        isActive: true,
      },
    });

    res.status(201).json({ success: true, room });
  } catch (err) {
    console.error('Error creating room:', err);
    res.status(500).json({ error: 'Failed to create room' });
  }
});

// DELETE /rooms/:id - Delete / Deactivate a TalkRoom (Admin only)
router.delete('/rooms/:id', authenticateJWT, authorizeRoles('ADMIN'), async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    await prisma.talkRoom.delete({
      where: { id: id as string },
    });
    res.status(200).json({ success: true });
  } catch (err) {
    console.error('Error deleting room:', err);
    res.status(500).json({ error: 'Failed to delete room' });
  }
});

// GET /profile - Fetch current user's TalkMindly profile state
router.get('/profile', authenticateJWT, async (req: Request, res: Response) => {
  try {
    const userId = req.user?.sub;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        talkNickname: true,
        talkAvatar: true,
        talkBio: true,
        talkTermsAccepted: true,
      },
    });

    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    res.status(200).json(user);
  } catch (err) {
    console.error('Error fetching Talk profile:', err);
    res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

// POST /profile - Set up or update TalkMindly profile
router.post('/profile', authenticateJWT, async (req: Request, res: Response) => {
  try {
    const userId = req.user?.sub;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const { nickname, avatar, bio, acceptTerms } = req.body as {
      nickname?: string;
      avatar?: string;
      bio?: string;
      acceptTerms?: boolean;
    };

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    if (nickname && nickname !== user.talkNickname) {
      const existing = await prisma.user.findUnique({
        where: { talkNickname: nickname },
      });
      if (existing) {
        res.status(400).json({ error: 'This nickname is already taken by another peer' });
        return;
      }
    }

    const updateData: any = {};
    if (acceptTerms !== undefined) updateData.talkTermsAccepted = acceptTerms;
    if (bio !== undefined) updateData.talkBio = bio;

    if (nickname) {
      if (user.talkNickname && req.user?.role !== 'ADMIN') {
        res.status(400).json({ error: 'Nickname can only be set once' });
        return;
      }
      updateData.talkNickname = nickname;
    }

    if (avatar) {
      if (user.talkAvatar && req.user?.role !== 'ADMIN') {
        res.status(400).json({ error: 'Avatar can only be set once' });
        return;
      }
      updateData.talkAvatar = avatar;
    }

    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: updateData,
      select: {
        talkNickname: true,
        talkAvatar: true,
        talkBio: true,
        talkTermsAccepted: true,
      },
    });

    res.status(200).json(updatedUser);
  } catch (err) {
    console.error('Error updating Talk profile:', err);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

// POST /rooms (Admin Only) - Create a room
router.post(
  '/rooms',
  authenticateJWT,
  authorizeRoles('ADMIN'),
  async (req: Request, res: Response) => {
    try {
      const { name, description } = req.body as { name: string; description?: string };
      if (!name) {
        res.status(400).json({ error: 'Room name is required' });
        return;
      }

      const existing = await prisma.talkRoom.findUnique({ where: { name } });
      if (existing) {
        res.status(400).json({ error: 'Room with this name already exists' });
        return;
      }

      const room = await prisma.talkRoom.create({
        data: { name, description, isActive: true },
      });
      res.status(201).json(room);
    } catch (err) {
      console.error('Error creating room:', err);
      res.status(500).json({ error: 'Failed to create room' });
    }
  }
);

// PUT /rooms/:roomId (Admin Only) - Toggle/update a room
router.put(
  '/rooms/:roomId',
  authenticateJWT,
  authorizeRoles('ADMIN'),
  async (req: Request, res: Response) => {
    try {
      const { name, description, isActive } = req.body as {
        name?: string;
        description?: string;
        isActive?: boolean;
      };

      const room = await prisma.talkRoom.update({
        where: { id: req.params.roomId as string },
        data: { name, description, isActive },
      });
      res.status(200).json(room);
    } catch (err) {
      console.error('Error updating room:', err);
      res.status(500).json({ error: 'Failed to update room' });
    }
  }
);

// DELETE /rooms/:roomId (Admin Only) - Delete a room
router.delete(
  '/rooms/:roomId',
  authenticateJWT,
  authorizeRoles('ADMIN'),
  async (req: Request, res: Response) => {
    try {
      await prisma.talkRoom.delete({
        where: { id: req.params.roomId as string },
      });
      res.status(200).json({ success: true });
    } catch (err) {
      console.error('Error deleting room:', err);
      res.status(500).json({ error: 'Failed to delete room' });
    }
  }
);

// ==========================================
// 2. TalkNotes & Replies Board
// ==========================================

// GET /rooms/:roomId/notes - Fetch paginated room notes
router.get('/rooms/:roomId/notes', authenticateJWT, async (req: Request, res: Response) => {
  try {
    const page = parseInt(req.query.page as string || '1', 10);
    const limit = parseInt(req.query.limit as string || '30', 10);
    const skip = (page - 1) * limit;
    const userId = req.user?.sub;
    const sort = req.query.sort as string || 'recent';

    const orderBy: any = {};
    if (sort === 'interactive') {
      orderBy.meTooCount = 'desc';
    } else {
      orderBy.createdAt = 'desc';
    }

    const notes = await prisma.talkNote.findMany({
      where: {
        roomId: req.params.roomId as string,
        OR: [
          { status: TalkStatus.APPROVED },
          { userId: userId }, // Author can see their own flagged/pending notes
        ],
      },
      orderBy,
      skip,
      take: limit,
      select: {
        id: true,
        userId: true,
        nickname: true,
        avatar: true,
        content: true,
        status: true,
        moderationReason: true,
        meTooCount: true,
        createdAt: true,
        replies: {
          where: {
            OR: [
              { status: TalkStatus.APPROVED },
              { userId: userId },
            ],
          },
          orderBy: { createdAt: 'asc' },
          select: {
            id: true,
            userId: true,
            nickname: true,
            avatar: true,
            content: true,
            status: true,
            moderationReason: true,
            createdAt: true,
          },
        },
        reactions: { select: { id: true, userId: true, type: true } },
      },
    });

    const shaped = notes.map((n) => ({
      id: n.id,
      nickname: n.nickname,
      avatar: n.avatar,
      content: n.content,
      status: n.status,
      moderationReason: n.moderationReason,
      meTooCount: n.meTooCount,
      createdAt: n.createdAt,
      isMine: n.userId === userId,
      replies: n.replies.map((r) => ({
        id: r.id,
        nickname: r.nickname,
        avatar: r.avatar,
        content: r.content,
        status: r.status,
        moderationReason: r.moderationReason,
        createdAt: r.createdAt,
        isMine: r.userId === userId,
      })),
      reactions: n.reactions.map((x) => ({
        id: x.id,
        type: x.type,
        isMine: x.userId === userId,
      })),
    }));

    res.status(200).json(shaped);
  } catch (err) {
    console.error('Error fetching notes:', err);
    res.status(500).json({ error: 'Failed to fetch notes' });
  }
});

// POST /rooms/:roomId/notes - Submit a new note
router.post('/rooms/:roomId/notes', authenticateJWT, async (req: Request, res: Response) => {
  try {
    const userId = req.user?.sub;
    if (!userId) {
      res.status(401).json({ error: 'User ID missing' });
      return;
    }

    const { content } = req.body as { content: string };

    if (!content || content.trim().length === 0) {
      res.status(400).json({ error: 'Content cannot be empty' });
      return;
    }

    const BANNED_WORDS = [
      'fuck', 'shit', 'bitch', 'asshole', 'bastard', 'cunt', 'nigger', 'retard', 'faggot',
      'suck', 'dick', 'cock', 'pussy', 'sex', 'boobs', 'penis', 'vagina', 'cum', 'horny',
      'blowjob', 'whore', 'slut'
    ];
    const lowerContent = content.toLowerCase();
    const hasProfanity = BANNED_WORDS.some(word => lowerContent.includes(word));
    if (hasProfanity) {
      res.status(400).json({ error: 'Please keep your message friendly and supportive. Profanity or explicit content is not allowed.' });
      return;
    }

    if (content.length > 280) {
      res.status(400).json({ error: 'Content exceeds 280 characters limit' });
      return;
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        talkTermsAccepted: true,
        talkNickname: true,
        talkAvatar: true,
      }
    });

    if (!user || !user.talkTermsAccepted || !user.talkNickname) {
      res.status(400).json({ error: 'You must accept the terms and set up your peer profile before posting' });
      return;
    }

    // Moderate before create
    const moderation = await moderateBeforeCreate(content);

    const note = await prisma.talkNote.create({
      data: {
        roomId: req.params.roomId as string,
        userId,
        nickname: user.talkNickname,
        avatar: user.talkAvatar || 'panda',
        content,
        status: moderation.status,
        moderationReason: moderation.moderationReason,
        isReported: moderation.isCrisis,
        inputTokens: moderation.inputTokens,
        outputTokens: moderation.outputTokens,
      },
      select: {
        id: true,
        userId: true,
        nickname: true,
        avatar: true,
        content: true,
        status: true,
        moderationReason: true,
        meTooCount: true,
        createdAt: true,
        replies: {
          select: {
            id: true,
            userId: true,
            nickname: true,
            avatar: true,
            content: true,
            status: true,
            moderationReason: true,
            createdAt: true,
          },
        },
        reactions: { select: { id: true, userId: true, type: true } },
      },
    });

    const shapedNote = {
      id: note.id,
      nickname: note.nickname,
      avatar: note.avatar,
      content: note.content,
      status: note.status,
      moderationReason: note.moderationReason,
      meTooCount: note.meTooCount,
      createdAt: note.createdAt,
      isMine: note.userId === userId,
      replies: note.replies.map((r) => ({
        id: r.id,
        nickname: r.nickname,
        avatar: r.avatar,
        content: r.content,
        status: r.status,
        moderationReason: r.moderationReason,
        createdAt: r.createdAt,
        isMine: r.userId === userId,
      })),
      reactions: note.reactions.map((x) => ({
        id: x.id,
        type: x.type,
        isMine: x.userId === userId,
      })),
    };

    const message = moderation.isCrisis
      ? "What you wrote has been kept off the board for now, and someone on our team will read it. That review is not instant, and we are not an emergency service - so if you need help sooner, the people on the next page can talk to you today."
      : moderation.status === TalkStatus.REJECTED
        ? "That one hasn't gone up on the board. It's on your screen with a note about why, and nobody else can see it."
        : "Note dropped on the wall successfully.";

    res.status(201).json({
      note: shapedNote,
      isCrisis: moderation.isCrisis,
      message,
    });
  } catch (err) {
    console.error('Error creating note:', err);
    res.status(500).json({ error: 'Failed to drop note' });
  }
});

// POST /notes/:noteId/replies - Submit threaded reply
router.post('/notes/:noteId/replies', authenticateJWT, async (req: Request, res: Response) => {
  try {
    const userId = req.user?.sub;
    if (!userId) {
      res.status(401).json({ error: 'User ID missing' });
      return;
    }

    const { content } = req.body as { content: string };

    if (!content || content.trim().length === 0) {
      res.status(400).json({ error: 'Content cannot be empty' });
      return;
    }

    const BANNED_WORDS = [
      'fuck', 'shit', 'bitch', 'asshole', 'bastard', 'cunt', 'nigger', 'retard', 'faggot',
      'suck', 'dick', 'cock', 'pussy', 'sex', 'boobs', 'penis', 'vagina', 'cum', 'horny',
      'blowjob', 'whore', 'slut'
    ];
    const lowerContent = content.toLowerCase();
    const hasProfanity = BANNED_WORDS.some(word => lowerContent.includes(word));
    if (hasProfanity) {
      res.status(400).json({ error: 'Please keep your message friendly and supportive. Profanity or explicit content is not allowed.' });
      return;
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        talkTermsAccepted: true,
        talkNickname: true,
        talkAvatar: true,
      }
    });

    if (!user || !user.talkTermsAccepted || !user.talkNickname) {
      res.status(400).json({ error: 'You must accept the terms and set up your peer profile before replying' });
      return;
    }

    // Moderate before create
    const moderation = await moderateBeforeCreate(content);

    const reply = await prisma.talkReply.create({
      data: {
        noteId: req.params.noteId as string,
        userId,
        nickname: user.talkNickname,
        avatar: user.talkAvatar || 'panda',
        content,
        status: moderation.status,
        moderationReason: moderation.moderationReason,
        inputTokens: moderation.inputTokens,
        outputTokens: moderation.outputTokens,
      },
      select: {
        id: true,
        userId: true,
        nickname: true,
        avatar: true,
        content: true,
        status: true,
        moderationReason: true,
        createdAt: true,
      },
    });

    if (moderation.isCrisis) {
      await prisma.talkNote.update({
        where: { id: req.params.noteId as string },
        data: { isReported: true },
      });
    }

    const shapedReply = {
      id: reply.id,
      nickname: reply.nickname,
      avatar: reply.avatar,
      content: reply.content,
      status: reply.status,
      moderationReason: reply.moderationReason,
      createdAt: reply.createdAt,
      isMine: reply.userId === userId,
    };

    const message = moderation.isCrisis
      ? "What you wrote has been kept off the board for now, and someone on our team will read it. That review is not instant, and we are not an emergency service - so if you need help sooner, the people on the next page can talk to you today."
      : moderation.status === TalkStatus.REJECTED
        ? "That one hasn't gone up on the board. It's on your screen with a note about why, and nobody else can see it."
        : "Reply added.";

    res.status(201).json({
      reply: shapedReply,
      isCrisis: moderation.isCrisis,
      message,
    });
  } catch (err) {
    console.error('Error creating reply:', err);
    res.status(500).json({ error: 'Failed to add reply' });
  }
});

// POST /notes/:noteId/react - Toggle reaction
router.post('/notes/:noteId/react', authenticateJWT, async (req: Request, res: Response) => {
  try {
    const userId = req.user?.sub;
    if (!userId) {
      res.status(401).json({ error: 'User ID missing' });
      return;
    }

    const { type } = req.body as { type: string };
    if (!type || !Object.values(ReactionType).includes(type as ReactionType)) {
      res.status(400).json({ error: 'Invalid reaction type' });
      return;
    }

    const reactionType = type as ReactionType;

    // Check if user already reacted with this type
    const existing = await prisma.talkReaction.findUnique({
      where: {
        noteId_userId_type: {
          noteId: req.params.noteId as string,
          userId,
          type: reactionType,
        },
      },
    });

    if (existing) {
      // Toggle off - Delete reaction
      await prisma.talkReaction.delete({
        where: { id: existing.id },
      });
      if (reactionType === ReactionType.METOO) {
        await prisma.talkNote.update({
          where: { id: req.params.noteId as string },
          data: { meTooCount: { decrement: 1 } },
        });
      }
      res.status(200).json({ status: 'removed' });
    } else {
      // Toggle on - Create reaction
      await prisma.talkReaction.create({
        data: {
          noteId: req.params.noteId as string,
          userId,
          type: reactionType,
        },
      });
      if (reactionType === ReactionType.METOO) {
        await prisma.talkNote.update({
          where: { id: req.params.noteId as string },
          data: { meTooCount: { increment: 1 } },
        });
      }
      res.status(201).json({ status: 'added' });
    }
  } catch (err) {
    console.error('Error toggling reaction:', err);
    res.status(500).json({ error: 'Failed to update reaction' });
  }
});

// POST /notes/:noteId/report - Flag a note
router.post('/notes/:noteId/report', authenticateJWT, async (req: Request, res: Response) => {
  try {
    const userId = req.user?.sub;
    if (!userId) {
      res.status(401).json({ error: 'User ID missing' });
      return;
    }

    const { reason } = (req.body || {}) as { reason?: string };

    // Validate that note exists
    const note = await prisma.talkNote.findUnique({
      where: { id: req.params.noteId as string },
    });

    if (!note) {
      res.status(404).json({ error: 'Note not found' });
      return;
    }

    await prisma.talkReport.create({
      data: {
        noteId: req.params.noteId as string,
        userId,
        reason,
      },
    });

    // Update note flag
    await prisma.talkNote.update({
      where: { id: req.params.noteId as string },
      data: {
        isReported: true,
        status: TalkStatus.FLAGGED, // Flag note pending review
      },
    });

    res.status(200).json({ success: true });
  } catch (err) {
    console.error('Error reporting note:', err);
    res.status(500).json({ error: 'Failed to report note' });
  }
});

// POST /replies/:replyId/report - Flag a reply
router.post('/replies/:replyId/report', authenticateJWT, async (req: Request, res: Response) => {
  try {
    const userId = req.user?.sub;
    if (!userId) {
      res.status(401).json({ error: 'User ID missing' });
      return;
    }

    const { reason } = (req.body || {}) as { reason?: string };

    // Validate that reply exists
    const reply = await prisma.talkReply.findUnique({
      where: { id: req.params.replyId as string },
    });

    if (!reply) {
      res.status(404).json({ error: 'Reply not found' });
      return;
    }

    await prisma.talkReport.create({
      data: {
        replyId: req.params.replyId as string,
        userId,
        reason,
      },
    });

    await prisma.talkReply.update({
      where: { id: req.params.replyId as string },
      data: {
        status: TalkStatus.FLAGGED, // Hide reply pending review
      },
    });

    res.status(200).json({ success: true });
  } catch (err) {
    console.error('Error reporting reply:', err);
    res.status(500).json({ error: 'Failed to report reply' });
  }
});

// DELETE /notes/:noteId - Delete user's own note
router.delete('/notes/:noteId', authenticateJWT, async (req: Request, res: Response) => {
  try {
    const userId = req.user?.sub;
    const userRole = req.user?.role;
    if (!userId) {
      res.status(401).json({ error: 'User ID missing' });
      return;
    }

    const note = await prisma.talkNote.findUnique({
      where: { id: req.params.noteId as string },
    });

    if (!note) {
      res.status(404).json({ error: 'Note not found' });
      return;
    }

    if (note.userId !== userId && userRole !== 'ADMIN') {
      res.status(403).json({ error: 'Unauthorized to delete this note' });
      return;
    }

    await prisma.talkNote.delete({
      where: { id: req.params.noteId as string },
    });

    res.status(200).json({ success: true });
  } catch (err) {
    console.error('Error deleting note:', err);
    res.status(500).json({ error: 'Failed to delete note' });
  }
});

// DELETE /replies/:replyId - Delete user's own reply
router.delete('/replies/:replyId', authenticateJWT, async (req: Request, res: Response) => {
  try {
    const userId = req.user?.sub;
    const userRole = req.user?.role;
    if (!userId) {
      res.status(401).json({ error: 'User ID missing' });
      return;
    }

    const reply = await prisma.talkReply.findUnique({
      where: { id: req.params.replyId as string },
    });

    if (!reply) {
      res.status(404).json({ error: 'Reply not found' });
      return;
    }

    if (reply.userId !== userId && userRole !== 'ADMIN') {
      res.status(403).json({ error: 'Unauthorized to delete this reply' });
      return;
    }

    await prisma.talkReply.delete({
      where: { id: req.params.replyId as string },
    });

    res.status(200).json({ success: true });
  } catch (err) {
    console.error('Error deleting reply:', err);
    res.status(500).json({ error: 'Failed to delete reply' });
  }
});

// ==========================================
// 3. Admin Moderation Controllers
// ==========================================

// GET /moderation - Retrieve reported/pending items (Admin Only)
router.get(
  '/moderation',
  authenticateJWT,
  authorizeRoles('ADMIN'),
  async (req: Request, res: Response) => {
    try {
      const flaggedNotes = await prisma.talkNote.findMany({
        where: {
          OR: [
            { isReported: true },
            { status: TalkStatus.FLAGGED },
            { status: TalkStatus.PENDING },
            { status: TalkStatus.REJECTED },
          ],
        },
        orderBy: { createdAt: 'desc' },
        include: {
          reports: true,
          room: true,
        },
      });

      const flaggedReplies = await prisma.talkReply.findMany({
        where: {
          OR: [
            { status: TalkStatus.FLAGGED },
            { status: TalkStatus.PENDING },
            { status: TalkStatus.REJECTED },
          ],
        },
        orderBy: { createdAt: 'desc' },
        include: {
          reports: true,
          note: {
            include: { room: true },
          },
        },
      });

      res.status(200).json({
        notes: flaggedNotes,
        replies: flaggedReplies,
      });
    } catch (err) {
      console.error('Error fetching moderation items:', err);
      res.status(500).json({ error: 'Failed to fetch moderation items' });
    }
  }
);

// POST /moderation/:type/:itemId/resolve (Admin Only) - Approve / Reject reported item
router.post(
  '/moderation/:type/:itemId/resolve',
  authenticateJWT,
  authorizeRoles('ADMIN'),
  async (req: Request, res: Response) => {
    try {
      const { type, itemId } = req.params;
      const { action } = req.body as { action: 'approve' | 'reject' };

      if (action !== 'approve' && action !== 'reject') {
        res.status(400).json({ error: 'Invalid moderation action' });
        return;
      }

      if (type === 'note') {
        const status = action === 'approve' ? TalkStatus.APPROVED : TalkStatus.REJECTED;
        await prisma.talkNote.update({
          where: { id: itemId as string },
          data: {
            status,
            isReported: false,
          },
        });
      } else if (type === 'reply') {
        const status = action === 'approve' ? TalkStatus.APPROVED : TalkStatus.REJECTED;
        await prisma.talkReply.update({
          where: { id: itemId as string },
          data: {
            status,
          },
        });
      } else {
        res.status(400).json({ error: 'Invalid moderation type' });
        return;
      }

      res.status(200).json({ success: true });
    } catch (err) {
      console.error('Error resolving moderation item:', err);
      res.status(500).json({ error: 'Failed to resolve moderation item' });
    }
  }
);

export default router;
