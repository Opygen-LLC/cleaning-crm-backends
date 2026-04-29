import { Router } from "express";

const router = Router();

router.get("/", (req, res) => {
  res.send("Staff route");
});

export const staffRoutes = router;
