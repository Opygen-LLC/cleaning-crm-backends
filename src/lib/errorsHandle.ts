export const handleError = (error: unknown) => {
  if (error instanceof Error) {
    return { message: error.message, stack: error.stack };
  } else {
    return { message: "An unknown error occurred" };
  }
};
