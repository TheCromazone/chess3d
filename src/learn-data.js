// Static content for the Learn section: endgame drills and a beginner lesson curriculum.
// Every FEN and every goal move here is checked by tools/test-data.mjs with chess.js.
//
// ENDGAME_DRILLS: play `fen` as `side` (always the side to move) against the engine.
//   goal "win":  checkmate the opponent.
//   goal "draw": don't lose: reach stalemate, repetition, insufficient material or the
//                50-move rule (a controller may also count "survived N moves" as success).
//   difficulty: 1 (basic) .. 3 (advanced technique).
//
// LESSONS: steps are shown in order. Every step's FEN has the learner (White in all current
// lessons) to move, info steps included, so the board never needs to flip mid-lesson.
//   goal { type: "info" }                 -> just text; show a "Next" button.
//   goal { type: "move", moves: [uci] }   -> any of the listed UCI moves (e.g. "e2e4", "e1g1", "a7a8q").
//   goal { type: "mate" }                 -> any move that gives checkmate.
//   goal { type: "capture", square }      -> any legal capture landing on `square`.

export const ENDGAME_DRILLS = [
  {
    id: "kq-vs-k", title: "Queen Checkmate", side: "w", goal: "win", difficulty: 1,
    fen: "8/8/8/4k3/8/8/8/3QK3 w - - 0 1",
    blurb: "Use the queen to shrink the king's box a knight's move away, bring your own king up, and mate on the edge. Watch out for stalemate!",
  },
  {
    id: "kr-vs-k", title: "Rook Checkmate", side: "w", goal: "win", difficulty: 1,
    fen: "8/8/8/4k3/8/8/8/R3K3 w - - 0 1",
    blurb: "Cut the king off with the rook, walk your king up to take the opposition, and push the enemy king to the edge one rank at a time.",
  },
  {
    id: "kbb-vs-k", title: "Two Bishops Checkmate", side: "w", goal: "win", difficulty: 2,
    fen: "8/8/8/4k3/8/8/8/2B1KB2 w - - 0 1",
    blurb: "Side by side, the bishops build a diagonal wall. Herd the king into a corner with help from your own king, then mate.",
  },
  {
    id: "kbn-vs-k", title: "Bishop and Knight Checkmate", side: "w", goal: "win", difficulty: 3,
    fen: "8/8/8/4k3/8/8/8/1N2KB2 w - - 0 1",
    blurb: "The hardest basic mate: drive the king to a corner of your bishop's color. You have 50 moves, so use the 'W' knight manoeuvre.",
  },
  {
    id: "kp-vs-k-key-square", title: "King and Pawn: Key Squares", side: "w", goal: "win", difficulty: 1,
    fen: "4k3/8/4K3/4P3/8/8/8/8 w - - 0 1",
    blurb: "Your king is on the sixth rank in front of its pawn, which wins no matter who moves. Escort the pawn home without allowing stalemate.",
  },
  {
    id: "kp-vs-k-opposition", title: "King and Pawn: Opposition", side: "w", goal: "win", difficulty: 2,
    fen: "8/8/4k3/8/4K3/8/4P3/8 w - - 0 1",
    blurb: "The kings face each other and it is your move. Spend a pawn tempo to hand the move back and win the opposition.",
  },
  {
    id: "kp-vs-k-defend", title: "King and Pawn: Hold the Draw", side: "b", goal: "draw", difficulty: 2,
    fen: "4k3/8/8/8/4P3/4K3/8/8 b - - 0 1",
    blurb: "Stay in front of the pawn and take the opposition whenever White's king comes close. Retreat straight back, not to the side.",
  },
  {
    id: "square-of-the-pawn", title: "The Square of the Pawn", side: "b", goal: "draw", difficulty: 1,
    fen: "8/8/8/8/P2k4/8/8/7K b - - 0 1",
    blurb: "Can your king catch the a-pawn? Draw the square from the pawn to its queening rank; if your king can step into it, you are in time.",
  },
  {
    id: "pawn-breakthrough", title: "Pawn Breakthrough", side: "w", goal: "win", difficulty: 2,
    fen: "7k/ppp5/8/PPP5/8/8/8/6K1 w - - 0 1",
    blurb: "Three pawns against three and both kings far away. Sacrifice two pawns in the right order so the third one queens.",
  },
  {
    id: "q-vs-pawn", title: "Queen vs Pawn on the 7th", side: "w", goal: "win", difficulty: 2,
    fen: "K7/8/8/8/8/8/3pk3/7Q w - - 0 1",
    blurb: "Check and pin until the black king has to stand in front of its own pawn, then use that tempo to bring your king closer.",
  },
  {
    id: "lucena", title: "Lucena Position", side: "w", goal: "win", difficulty: 3,
    fen: "1K6/1P1k4/8/8/8/8/r7/2R5 w - - 0 1",
    blurb: "The most important winning rook endgame: push the defending king away with a check, then 'build a bridge' with your rook on the fourth rank.",
  },
  {
    id: "philidor", title: "Philidor Position", side: "b", goal: "draw", difficulty: 2,
    fen: "4k3/R7/1r6/3KP3/8/8/8/8 b - - 0 1",
    blurb: "Keep your rook on the sixth rank so White's king can't advance. Once the pawn steps to e6, swing the rook back and check from behind.",
  },
  {
    id: "vancura", title: "Vancura Position", side: "b", goal: "draw", difficulty: 3,
    fen: "R7/6k1/P4r2/8/8/8/6K1/8 b - - 0 1",
    blurb: "Against a rook pawn, attack it from the side and keep your rook on the sixth rank, checking the white king whenever it approaches.",
  },
  {
    id: "opposite-bishops", title: "Opposite-Colored Bishops", side: "b", goal: "draw", difficulty: 1,
    fen: "8/8/3k1b2/3P4/2B1P3/5K2/8/8 b - - 0 1",
    blurb: "Two pawns down, yet a draw: blockade on the dark squares, which White's light-squared bishop can never challenge.",
  },
  {
    id: "wrong-rook-pawn", title: "The Wrong Rook Pawn", side: "b", goal: "draw", difficulty: 1,
    fen: "7k/8/6K1/7P/8/8/4B3/8 b - - 0 1",
    blurb: "White's bishop can't control h8, so your king can never be driven out of the corner. Shuffle between g8 and h8.",
  },
];

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

export const LESSONS = [
  {
    id: "rook-and-bishop", title: "The Rook and the Bishop", category: "Basics",
    steps: [
      { text: "The rook moves any number of squares in a straight line: up, down, left or right. It can't jump over other pieces.",
        fen: "4k3/8/8/8/3R4/8/8/4K3 w - - 0 1", goal: { type: "info" } },
      { text: "Slide the rook all the way across the board to h4.",
        fen: "4k3/8/8/8/3R4/8/8/4K3 w - - 0 1", goal: { type: "move", moves: ["d4h4"] } },
      { text: "Pieces capture by moving onto an enemy piece's square. Capture the black knight with your rook.",
        fen: "7k/8/8/8/3R2n1/8/8/4K3 w - - 0 1", goal: { type: "capture", square: "g4" } },
      { text: "The bishop moves any number of squares diagonally. It always stays on squares of one color.",
        fen: "4k3/7p/8/8/3B4/8/7P/4K3 w - - 0 1", goal: { type: "info" } },
      { text: "Move the bishop to the corner square h8.",
        fen: "4k3/7p/8/8/3B4/8/7P/4K3 w - - 0 1", goal: { type: "move", moves: ["d4h8"] } },
      { text: "Capture the black rook with your bishop.",
        fen: "4k3/r7/8/8/3B4/8/8/4K3 w - - 0 1", goal: { type: "capture", square: "a7" } },
    ],
  },
  {
    id: "queen-and-king", title: "The Queen and the King", category: "Basics",
    steps: [
      { text: "The queen is the strongest piece: she moves like a rook and a bishop combined, any distance in any straight line.",
        fen: "4k3/8/8/8/3Q4/8/8/4K3 w - - 0 1", goal: { type: "info" } },
      { text: "Move the queen diagonally to a7.",
        fen: "4k3/8/8/8/3Q4/8/8/4K3 w - - 0 1", goal: { type: "move", moves: ["d4a7"] } },
      { text: "Capture the black rook with your queen.",
        fen: "4k3/8/8/8/3Q3r/8/8/4K3 w - - 0 1", goal: { type: "capture", square: "h4" } },
      { text: "The king moves one square in any direction. It may never move onto a square where it could be captured.",
        fen: "4k3/7p/8/8/8/8/7P/4K3 w - - 0 1", goal: { type: "info" } },
      { text: "Step your king one square forward, toward the center.",
        fen: "4k3/7p/8/8/8/8/7P/4K3 w - - 0 1", goal: { type: "move", moves: ["e1d2", "e1e2", "e1f2"] } },
      { text: "The king can capture too, as long as the piece is unprotected. Take the pawn.",
        fen: "4k3/8/8/4p3/4K3/8/8/8 w - - 0 1", goal: { type: "capture", square: "e5" } },
    ],
  },
  {
    id: "knight", title: "The Knight", category: "Basics",
    steps: [
      { text: "The knight moves in an L: two squares in one direction, then one square to the side. It is the only piece that can jump over others.",
        fen: "4k3/7p/8/8/3N4/8/7P/4K3 w - - 0 1", goal: { type: "info" } },
      { text: "Jump the knight to e6.",
        fen: "4k3/7p/8/8/3N4/8/7P/4K3 w - - 0 1", goal: { type: "move", moves: ["d4e6"] } },
      { text: "Your knight is surrounded by pawns, but knights jump! Leap over them and capture the bishop.",
        fen: "4k3/8/8/8/8/2b5/PPPP4/1N2K3 w - - 0 1", goal: { type: "capture", square: "c3" } },
    ],
  },
  {
    id: "pawns", title: "Pawns and Promotion", category: "Basics",
    steps: [
      { text: "Pawns move straight forward one square, or two squares on their very first move. They never move backwards.",
        fen: "4k3/8/8/8/8/8/4P3/4K3 w - - 0 1", goal: { type: "info" } },
      { text: "Push the pawn two squares forward.",
        fen: "4k3/8/8/8/8/8/4P3/4K3 w - - 0 1", goal: { type: "move", moves: ["e2e4"] } },
      { text: "Pawns capture one square diagonally forward. The pawn in front blocks you, but the knight is a target. Capture it!",
        fen: "4k3/8/8/3np3/4P3/8/8/4K3 w - - 0 1", goal: { type: "capture", square: "d5" } },
      { text: "A pawn that reaches the last rank promotes, usually to a queen. Promote your pawn to a queen.",
        fen: "7k/P7/8/8/8/8/8/4K3 w - - 0 1", goal: { type: "move", moves: ["a7a8q"] } },
    ],
  },
  {
    id: "check-and-checkmate", title: "Check and Checkmate", category: "Basics",
    steps: [
      { text: "A king that is attacked is in check. Checkmate means the king is in check and has no way out: that wins the game.",
        fen: "6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1", goal: { type: "info" } },
      { text: "Give check: move the rook so it attacks the black king.",
        fen: "4k3/8/8/8/8/8/8/R3K3 w - - 0 1", goal: { type: "move", moves: ["a1a8"] } },
      { text: "Now you are in check from the rook on e8! Get out of check. Here the only way is to move your king.",
        fen: "4r1k1/8/8/8/8/8/5PPP/4K3 w - - 0 1", goal: { type: "move", moves: ["e1d1", "e1d2", "e1f1"] } },
      { text: "Your king guards g7 and h7. Find a queen move that gives checkmate.",
        fen: "7k/8/6K1/8/8/8/8/1Q6 w - - 0 1", goal: { type: "mate" } },
      { text: "If a player has no legal move but is NOT in check, it is stalemate, and the game is a draw. Here Qb6?? would leave Black with no move at all. Always leave the losing king a move until you can mate it!",
        fen: "k7/2K5/8/8/8/8/8/1Q6 w - - 0 1", goal: { type: "info" } },
    ],
  },
  {
    id: "special-moves", title: "Castling and En Passant", category: "Basics",
    steps: [
      { text: "Castling moves the king two squares toward a rook, and the rook jumps to the king's other side. It is allowed only if neither piece has moved, the squares between are empty, and the king is not in, through or into check.",
        fen: "r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R3K2R w KQkq - 0 1", goal: { type: "info" } },
      { text: "Castle kingside: move your king two squares to the right.",
        fen: "r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R3K2R w KQkq - 0 1", goal: { type: "move", moves: ["e1g1"] } },
      { text: "Castle queenside: move your king two squares to the left.",
        fen: "r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R3K2R w KQkq - 0 1", goal: { type: "move", moves: ["e1c1"] } },
      { text: "En passant: when a pawn advances two squares and lands right beside your pawn, you may capture it as if it had moved only one square, but only on the very next move.",
        fen: "4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1", goal: { type: "info" } },
      { text: "Black just played d7-d5. Capture it en passant!",
        fen: "4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1", goal: { type: "move", moves: ["e5d6"] } },
    ],
  },
  {
    id: "forks", title: "Forks", category: "Tactics",
    steps: [
      { text: "A fork is one piece attacking two (or more) enemy pieces at the same time. Your opponent can only save one of them.",
        fen: "r3k3/8/8/1N6/8/8/8/4K3 w - - 0 1", goal: { type: "info" } },
      { text: "Find the knight move that checks the king and attacks the rook at the same time.",
        fen: "r3k3/8/8/1N6/8/8/8/4K3 w - - 0 1", goal: { type: "move", moves: ["b5c7"] } },
      { text: "The king had to move. Collect the rook!",
        fen: "r7/2N1k3/8/8/8/8/8/4K3 w - - 0 1", goal: { type: "capture", square: "a8" } },
      { text: "Queens fork too. Find the queen check that also attacks the rook in the corner.",
        fen: "r5k1/6pp/8/8/8/8/5PPP/3Q2K1 w - - 0 1", goal: { type: "move", moves: ["d1d5"] } },
      { text: "Even a humble pawn can fork. Push a pawn to attack both the knight and the bishop.",
        fen: "4k3/8/8/2n1b3/8/4P3/3P4/4K3 w - - 0 1", goal: { type: "move", moves: ["d2d4"] } },
    ],
  },
  {
    id: "pins", title: "Pins", category: "Tactics",
    steps: [
      { text: "A pin attacks a piece that can't move out of the way without exposing a more valuable piece behind it. If that piece is the king, the pinned piece can't legally move at all.",
        fen: "4k3/8/2n5/8/8/8/8/4KB2 w - - 0 1", goal: { type: "info" } },
      { text: "Pin the knight to the black king with your bishop.",
        fen: "4k3/8/2n5/8/8/8/8/4KB2 w - - 0 1", goal: { type: "move", moves: ["f1b5"] } },
      { text: "The pinned knight can't move, not even to capture your pawn. Attack it with the pawn to win it.",
        fen: "4k3/8/2n5/1B6/3P4/8/8/4K3 w - - 0 1", goal: { type: "move", moves: ["d4d5"] } },
      { text: "Pin the black queen to its king. Your b3 pawn keeps the bishop protected, so the queen can't simply take it.",
        fen: "6k1/6pp/8/3q4/8/1P6/P3BPPP/6K1 w - - 0 1", goal: { type: "move", moves: ["e2c4"] } },
    ],
  },
  {
    id: "skewers", title: "Skewers", category: "Tactics",
    steps: [
      { text: "A skewer is a pin in reverse: you attack a valuable piece, and when it moves away, you capture the piece standing behind it.",
        fen: "3q4/8/8/3k4/8/8/8/R5K1 w - - 0 1", goal: { type: "info" } },
      { text: "Check the king along the d-file. When it moves, the queen behind it falls.",
        fen: "3q4/8/8/3k4/8/8/8/R5K1 w - - 0 1", goal: { type: "move", moves: ["a1d1"] } },
      { text: "Skewer the king and rook along the long diagonal with your bishop.",
        fen: "r7/8/2k5/8/8/8/8/1B4K1 w - - 0 1", goal: { type: "move", moves: ["b1e4"] } },
      { text: "The king stepped aside. Capture the rook!",
        fen: "r7/8/3k4/8/4B3/8/8/6K1 w - - 0 1", goal: { type: "capture", square: "a8" } },
    ],
  },
  {
    id: "back-rank", title: "Back-Rank Mate", category: "Tactics",
    steps: [
      { text: "A king hiding behind its own unmoved pawns can be mated by a rook or queen on the back rank, because the pawns block every escape.",
        fen: "6k1/5ppp/8/8/8/8/5PPP/4R1K1 w - - 0 1", goal: { type: "info" } },
      { text: "Deliver a back-rank mate with your rook.",
        fen: "6k1/5ppp/8/8/8/8/5PPP/4R1K1 w - - 0 1", goal: { type: "mate" } },
      { text: "The same idea works with the queen. Checkmate!",
        fen: "6k1/5ppp/8/8/8/8/1Q3PPP/6K1 w - - 0 1", goal: { type: "mate" } },
      { text: "Now it's your back rank in danger: Black threatens ...Re1 mate. Push a pawn in front of your king to give it an escape square (called 'luft').",
        fen: "4r1k1/5ppp/8/8/8/8/5PPP/6K1 w - - 0 1", goal: { type: "move", moves: ["h2h3", "h2h4", "g2g3", "g2g4", "f2f3", "f2f4"] } },
    ],
  },
  {
    id: "discovered-attacks", title: "Discovered Attacks", category: "Tactics",
    steps: [
      { text: "A discovered attack happens when you move one piece out of the way and uncover an attack by the piece behind it. The piece that moves can make a threat of its own, so your opponent faces two threats at once.",
        fen: "1k1r4/pp6/4pq2/8/3N4/7P/1B3PP1/4R1K1 w - - 0 1", goal: { type: "info" } },
      { text: "Your bishop on b2 is aimed at the black queen, but your own knight is in the way. Move the knight with check, and the bishop's attack is uncovered at the same time.",
        fen: "1k1r4/pp6/4pq2/8/3N4/7P/1B3PP1/4R1K1 w - - 0 1", goal: { type: "move", moves: ["d4c6"] } },
      { text: "Black had to answer the check and took your knight. Nothing protects the queen from your bishop now. Take it!",
        fen: "1k1r4/p7/2p1pq2/8/8/7P/1B3PP1/4R1K1 w - - 0 2", goal: { type: "capture", square: "f6" } },
      { text: "The strongest kind is a discovered check: the uncovered piece gives check, so the piece that moves is free to go almost anywhere, even to grab something big.",
        fen: "1q2k3/pp1p1ppp/8/4B3/8/8/PPP2PPP/4R1K1 w - - 0 1", goal: { type: "info" } },
      { text: "Capture the black queen with your bishop. Moving the bishop uncovers a check from your rook on e1, so Black has to deal with that first.",
        fen: "1q2k3/pp1p1ppp/8/4B3/8/8/PPP2PPP/4R1K1 w - - 0 1", goal: { type: "move", moves: ["e5b8"] } },
    ],
  },
  {
    id: "double-check", title: "Double Check", category: "Tactics",
    steps: [
      { text: "In a double check, two pieces give check at the same time. Blocking or capturing can only stop one of them, so the king must move. If it has no safe square, it's checkmate.",
        fen: "3qkb1r/pppp1ppp/8/8/4N3/8/PPP2PPP/4R1K1 w - - 0 1", goal: { type: "info" } },
      { text: "Your rook on e1 lines up with the black king, and your knight stands in between. Jump the knight to a square where it gives check too. Checkmate!",
        fen: "3qkb1r/pppp1ppp/8/8/4N3/8/PPP2PPP/4R1K1 w - - 0 1", goal: { type: "mate" } },
      { text: "A real game: Reti against Tartakower, Vienna 1910. White has just sacrificed the queen on d8, and the black king took it. A double check finishes the job.",
        fen: "rnbk1b1r/pp3ppp/2p5/4q3/4n3/8/PPPB1PPP/2KR1BNR w - - 0 10", goal: { type: "info" } },
      { text: "Move the bishop so that it gives check and also uncovers a check from your rook on d1.",
        fen: "rnbk1b1r/pp3ppp/2p5/4q3/4n3/8/PPPB1PPP/2KR1BNR w - - 0 10", goal: { type: "move", moves: ["d2g5"] } },
      { text: "The king ran to c7. Finish the game with checkmate.",
        fen: "rnb2b1r/ppk2ppp/2p5/4q1B1/4n3/8/PPP2PPP/2KR1BNR w - - 2 11", goal: { type: "mate" } },
    ],
  },
  {
    id: "deflection", title: "Deflection", category: "Tactics",
    steps: [
      { text: "Deflection forces a defender away from its job. If one piece is guarding something important, attack it or give check so that it has to leave.",
        fen: "r7/pp3pk1/5qp1/8/3Q4/8/PP3PP1/6KR w - - 0 1", goal: { type: "info" } },
      { text: "The black king on g7 is the only defender of the queen on f6. Trading queens gains nothing, so first give check with your rook on h7 to drag the king away.",
        fen: "r7/pp3pk1/5qp1/8/3Q4/8/PP3PP1/6KR w - - 0 1", goal: { type: "move", moves: ["h1h7"] } },
      { text: "The king took your rook, so it no longer guards the queen. Capture the queen! You gave a rook and won a queen.",
        fen: "r7/pp3p1k/5qp1/8/3Q4/8/PP3PP1/6K1 w - - 0 2", goal: { type: "capture", square: "f6" } },
    ],
  },
  {
    id: "decoys", title: "Decoys and Attraction", category: "Tactics",
    steps: [
      { text: "A decoy lures an enemy piece, often the king, onto a square where a tactic is waiting. It usually begins with a sacrifice.",
        fen: "3q2k1/ppp2pp1/8/6N1/8/8/PPP2PP1/1K5R w - - 0 1", goal: { type: "info" } },
      { text: "If your knight took on f7 now, the king would simply take it back. Sacrifice your rook on h8 first to pull the king into the corner.",
        fen: "3q2k1/ppp2pp1/8/6N1/8/8/PPP2PP1/1K5R w - - 0 1", goal: { type: "move", moves: ["h1h8"] } },
      { text: "The king had to take the rook. Now it stands on h8, one knight jump from f7. Fork the king and the queen!",
        fen: "3q3k/ppp2pp1/8/6N1/8/8/PPP2PP1/1K6 w - - 0 2", goal: { type: "move", moves: ["g5f7"] } },
      { text: "The king stepped out of check. Collect the queen.",
        fen: "3q2k1/ppp2Np1/8/8/8/8/PPP2PP1/1K6 w - - 1 3", goal: { type: "capture", square: "d8" } },
    ],
  },
  {
    id: "removing-the-defender", title: "Removing the Defender", category: "Tactics",
    steps: [
      { text: "Sometimes a square or a piece is safe only because one enemy piece guards it. Capture that guard, and what it was protecting becomes a target.",
        fen: "3q1rk1/ppp2ppp/5n2/6B1/8/3B3Q/PPP2PPP/6K1 w - - 0 1", goal: { type: "info" } },
      { text: "Your queen and bishop both aim at h7, threatening mate. Only the knight on f6 stops it. Capture the knight!",
        fen: "3q1rk1/ppp2ppp/5n2/6B1/8/3B3Q/PPP2PPP/6K1 w - - 0 1", goal: { type: "move", moves: ["g5f6"] } },
      { text: "Black took back on f6, and now nothing guards h7. Deliver checkmate.",
        fen: "3q1rk1/ppp2p1p/5p2/8/8/3B3Q/PPP2PPP/6K1 w - - 0 2", goal: { type: "mate" } },
    ],
  },
  {
    id: "zwischenzug", title: "The In-Between Move", category: "Tactics",
    steps: [
      { text: "A zwischenzug (German for 'in-between move') is a forcing move, often a check, that you slip in before the move everyone expects, such as a recapture.",
        fen: "3r2k1/pp3pp1/7p/8/8/2q5/PP3PPP/3R2K1 w - - 0 1", goal: { type: "info" } },
      { text: "Black has just taken your queen on c3. Taking back with bxc3 looks natural, but then ...Rxd1 is checkmate! First capture the rook on d8 with check.",
        fen: "3r2k1/pp3pp1/7p/8/8/2q5/PP3PPP/3R2K1 w - - 0 1", goal: { type: "move", moves: ["d1d8"] } },
      { text: "The king had to step to h7. Now take back the queen. Thanks to the in-between move, you are a whole rook ahead.",
        fen: "3R4/pp3ppk/7p/8/8/2q5/PP3PPP/6K1 w - - 1 2", goal: { type: "capture", square: "c3" } },
    ],
  },
  {
    id: "overloading", title: "Overloaded Pieces", category: "Tactics",
    steps: [
      { text: "A piece is overloaded when it has two jobs at once. Force it to do one job, and the other is left undone.",
        fen: "3r2k1/pp3ppp/8/3n4/2B5/8/PP3PPP/4R1K1 w - - 0 1", goal: { type: "info" } },
      { text: "The rook on d8 guards the knight on d5 and also guards the back rank. It can't do both. Capture the knight with your bishop.",
        fen: "3r2k1/pp3ppp/8/3n4/2B5/8/PP3PPP/4R1K1 w - - 0 1", goal: { type: "move", moves: ["c4d5"] } },
      { text: "Black took back with the rook, and the back rank is empty. Deliver checkmate!",
        fen: "6k1/pp3ppp/8/3r4/8/8/PP3PPP/4R1K1 w - - 0 2", goal: { type: "mate" } },
    ],
  },
  {
    id: "smothered-mate", title: "Smothered Mate", category: "Tactics",
    steps: [
      { text: "A smothered mate is a knight checkmate against a king that is completely surrounded by its own pieces, so it has nowhere to run.",
        fen: "6rk/6pp/8/6N1/8/8/6PP/6K1 w - - 0 1", goal: { type: "info" } },
      { text: "The black king is boxed in by its own rook and pawns. Deliver a smothered mate with your knight.",
        fen: "6rk/6pp/8/6N1/8/8/6PP/6K1 w - - 0 1", goal: { type: "mate" } },
      { text: "The most famous version starts with a queen sacrifice and is called Philidor's legacy. Your knight on h6 already covers g8.",
        fen: "5r1k/pp4pp/1q5N/8/2Q5/8/PP4PP/7K w - - 0 1", goal: { type: "info" } },
      { text: "Check the king from g8 with your queen! The knight protects her, so the king can't take, and the rook has to.",
        fen: "5r1k/pp4pp/1q5N/8/2Q5/8/PP4PP/7K w - - 0 1", goal: { type: "move", moves: ["c4g8"] } },
      { text: "The rook took your queen and now blocks its own king. Finish with a smothered mate.",
        fen: "6rk/pp4pp/1q5N/8/8/8/PP4PP/7K w - - 0 2", goal: { type: "mate" } },
    ],
  },
  {
    id: "opening-principles", title: "Opening Principles", category: "Strategy",
    steps: [
      { text: "Three goals in the opening: control the center, develop your knights and bishops, and castle your king to safety.",
        fen: START, goal: { type: "info" } },
      { text: "Grab a share of the center with a pawn: play e4 or d4.",
        fen: START, goal: { type: "move", moves: ["e2e4", "d2d4"] } },
      { text: "Develop a knight toward the center, where it controls the most squares.",
        fen: "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2", goal: { type: "move", moves: ["g1f3", "b1c3"] } },
      { text: "Bring out your light-squared bishop to an active square so you can castle.",
        fen: "r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3", goal: { type: "move", moves: ["f1c4", "f1b5"] } },
      { text: "Castle kingside to tuck your king away and connect your rooks.",
        fen: "r1bqk1nr/pppp1ppp/2n5/2b1p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4", goal: { type: "move", moves: ["e1g1"] } },
      { text: "Rules of thumb: don't move the same piece twice without a reason, don't bring the queen out too early, and don't grab pawns while your pieces are still at home.",
        fen: "r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/5N2/PPPP1PPP/RNBQ1RK1 w kq - 6 5", goal: { type: "info" } },
    ],
  },
  {
    id: "opening-traps", title: "Opening Traps", category: "Strategy",
    steps: [
      { text: "A few opening mistakes lose on the spot. Learn these traps so you can punish them, and so you never fall into them yourself.",
        fen: START, goal: { type: "info" } },
      { text: "The fool's mate: after 1.e4 f6 2.d4 g5, Black has torn open the diagonal to the king. Checkmate in one move!",
        fen: "rnbqkbnr/ppppp2p/5p2/6p1/3PP3/8/PPP2PPP/RNBQKBNR w KQkq - 0 3", goal: { type: "mate" } },
      { text: "Now your opponent tries the scholar's mate against you: the queen and bishop both hit f2, threatening ...Qxf2 mate. Guard f2 with your queen, or chase the black queen away with g3.",
        fen: "rnb1k1nr/pppp1ppp/8/2b1p3/2B1P2q/3P4/PPP2PPP/RNBQK1NR w KQkq - 1 4", goal: { type: "move", moves: ["d1e2", "d1f3", "g2g3", "d1d2"] } },
      { text: "Legal's mate: after 1.e4 e5 2.Nf3 d6 3.Bc4 Bg4 4.Nc3 g6, Black's bishop pins your knight to your queen. Or does it?",
        fen: "rn1qkbnr/ppp2p1p/3p2p1/4p3/2B1P1b1/2N2N2/PPPP1PPP/R1BQK2R w KQkq - 0 5", goal: { type: "info" } },
      { text: "Take the e5 pawn with the 'pinned' knight! If Black grabs your queen, a mate is waiting.",
        fen: "rn1qkbnr/ppp2p1p/3p2p1/4p3/2B1P1b1/2N2N2/PPPP1PPP/R1BQK2R w KQkq - 0 5", goal: { type: "move", moves: ["f3e5"] } },
      { text: "Black took the queen. Give check with your bishop on f7.",
        fen: "rn1qkbnr/ppp2p1p/3p2p1/4N3/2B1P3/2N5/PPPP1PPP/R1BbK2R w KQkq - 0 6", goal: { type: "move", moves: ["c4f7"] } },
      { text: "The king had to go to e7. Mate with your other knight!",
        fen: "rn1q1bnr/ppp1kB1p/3p2p1/4N3/4P3/2N5/PPPP1PPP/R1BbK2R w KQ - 1 7", goal: { type: "mate" } },
    ],
  },
  {
    id: "basic-checkmates", title: "Checkmate with the Queen", category: "Endgames",
    steps: [
      { text: "With king and queen against a lone king, use the queen to push the king to the edge, then bring your own king close to help deliver mate.",
        fen: "8/8/8/4k3/8/8/8/3QK3 w - - 0 1", goal: { type: "info" } },
      { text: "The black king is trapped on the edge. Mate it in one move.",
        fen: "k7/8/1K6/8/8/8/8/6Q1 w - - 0 1", goal: { type: "mate" } },
      { text: "Mate in one again, but be careful: one queen move here is stalemate!",
        fen: "k7/2K5/8/8/8/8/8/1Q6 w - - 0 1", goal: { type: "mate" } },
    ],
  },
  {
    id: "opposition", title: "The Opposition", category: "Endgames",
    steps: [
      { text: "When the two kings face each other on the same file with one square between them, they are in opposition. The side that does NOT have to move 'has the opposition': the other king must step aside.",
        fen: "8/8/4k3/8/4K3/8/4P3/8 w - - 0 1", goal: { type: "info" } },
      { text: "It's your move, so Black has the opposition for now. Win it back by pushing your pawn one square: that passes the move to Black.",
        fen: "8/8/4k3/8/4K3/8/4P3/8 w - - 0 1", goal: { type: "move", moves: ["e2e3"] } },
      { text: "Black had to give way. Step forward with your king: Kf5 goes around the black king, and Kd4 takes the opposition again. Both win.",
        fen: "8/8/3k4/8/4K3/4P3/8/8 w - - 1 2", goal: { type: "move", moves: ["e4f5", "e4d4"] } },
      { text: "A new position. Take the opposition yourself: put your king right in front of the black king, with one square between them.",
        fen: "8/8/4k3/8/5K2/4P3/8/8 w - - 0 1", goal: { type: "move", moves: ["f4e4"] } },
    ],
  },
  {
    id: "lucena", title: "The Lucena Position", category: "Endgames",
    steps: [
      { text: "In the Lucena position your pawn is on the seventh rank with your king in front of it. To promote, the king must step out without being checked forever. The trick is to 'build a bridge' with your rook.",
        fen: "1K6/1P1k4/8/8/8/8/r7/2R5 w - - 0 1", goal: { type: "info" } },
      { text: "First push the black king one more file away. Check it from the d-file.",
        fen: "1K6/1P1k4/8/8/8/8/r7/2R5 w - - 0 1", goal: { type: "move", moves: ["c1d1"] } },
      { text: "The king stepped to e7. Now lift your rook to the fourth rank. Later it will block the checks.",
        fen: "1K6/1P2k3/8/8/8/8/r7/3R4 w - - 2 2", goal: { type: "move", moves: ["d1d4"] } },
      { text: "Black is waiting. Step out with your king to c7. The black rook will start checking.",
        fen: "1K6/1P2k3/8/8/3R4/8/8/r7 w - - 4 3", goal: { type: "move", moves: ["b8c7"] } },
      { text: "Check! Walk toward your rook: go to b6.",
        fen: "8/1PK1k3/8/8/3R4/8/8/2r5 w - - 6 4", goal: { type: "move", moves: ["c7b6"] } },
      { text: "Check again. Keep walking: go to c6.",
        fen: "8/1P2k3/1K6/8/3R4/8/8/1r6 w - - 8 5", goal: { type: "move", moves: ["b6c6"] } },
      { text: "One more step: go to b5. If Black checks from b1, your rook is ready to block on b4.",
        fen: "8/1P2k3/2K5/8/3R4/8/8/2r5 w - - 10 6", goal: { type: "move", moves: ["c6b5"] } },
      { text: "Block the check with your rook on b4. That's the bridge: the checks are over and the pawn will promote.",
        fen: "8/1P2k3/8/1K6/3R4/8/8/1r6 w - - 12 7", goal: { type: "move", moves: ["d4b4"] } },
    ],
  },
];
