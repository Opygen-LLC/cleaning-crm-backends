interface ResponseData {
  statusCode: number;
  status: string;
  message: string;
  data?: object;
  type?: any;
  token?: string;
}

export const response = (response: ResponseData = {} as ResponseData) => {
  const responseObject: {
    code: number;
    status: string;
    message: string;
    data?: any;
  } = {
    code: response.statusCode,
    message: response.message,
    status: response.status,
    data: {},
  };

  if (response.type) {
    responseObject.data.type = response.type;
  }

  if (response.data) {
    responseObject.data = response.data;
  }

  if (response.token) {
    responseObject.data.token = response.token;
  }

  return responseObject;
};
